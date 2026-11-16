import type { BinaryFile, FileCheckpoint, FileProgress, RequestOptions } from "./contracts";
import type { AccountCache } from "./offline";
import { fileName } from "./media";
import { MAX_FILE_BYTES } from "./relay";
import { TransferError } from "./transfer-error";

export const FILE_SEGMENT_BYTES = 1024 * 1024;
const strongTag = (value: string) => /^"[^"\r\n]+"$/.test(value);

export function transferDelay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function downloadFileSegments(options: {
  request(options: RequestOptions): Promise<BinaryFile>;
  ready(): Promise<void>;
  signal: AbortSignal;
  cache: AccountCache | null;
  key: string;
  progress(value: FileProgress): void;
}): Promise<BinaryFile> {
  const { signal, cache, key, progress } = options;
  const saved = await cache?.partial(key).catch(() => null);
  let checkpoint: FileCheckpoint | undefined = saved?.checkpoint;
  let chunks = saved?.chunks ?? [];
  let failures = 0, versions = 0, full = false;
  for (;;) {
    signal.throwIfAborted();
    await options.ready();
    signal.throwIfAborted();
    const received = checkpoint?.received ?? 0;
    const validating = checkpoint && received === checkpoint.total;
    const start = validating ? 0 : received;
    const range = full ? undefined : { start, end: validating ? 0 : start + FILE_SEGMENT_BYTES - 1, ...(checkpoint ? { etag: checkpoint.etag } : {}) };
    progress({ received, total: checkpoint?.total, phase: "downloading" });
    let reply: BinaryFile;
    try {
      reply = await options.request({ signal, responseType: "bytes", range, onProgress: bytes => progress({ received: received + (validating ? 0 : bytes), total: checkpoint?.total, phase: "downloading" }) });
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof TransferError && error.status === 416 && !full) {
        full = true; checkpoint = undefined; chunks = []; await cache?.clearPartial(key); continue;
      }
      if (!(error instanceof TransferError && error.retryable) && !(error instanceof TypeError) && !(error instanceof DOMException && error.name === "TimeoutError")) throw error;
      if (++failures > 5) throw new TransferError("传输暂时无法继续，已保留下载进度，点击重试即可续传。", true);
      progress({ received, total: checkpoint?.total, phase: "reconnecting" });
      await transferDelay(Math.min(1000 * 2 ** (failures - 1), 15_000), signal);
      continue;
    }
    signal.throwIfAborted();
    const part = reply.range;
    if (!part) {
      if (reply.data.length > MAX_FILE_BYTES) throw new TransferError("文件超过手机端 100 MB 的读取上限。", false);
      await cache?.clearPartial(key);
      progress({ received: reply.data.length, total: reply.data.length, phase: "downloading" });
      return { data: reply.data, mime: reply.mime, name: reply.name };
    }
    if (![part.start, part.end, part.total].every(Number.isSafeInteger) || part.start !== start || part.end < start || part.end !== Math.min(range?.end ?? -1, part.total - 1)
      || part.end >= part.total || part.total > MAX_FILE_BYTES || part.end - part.start + 1 !== reply.data.length) throw new TransferError("文件分段响应无效，无法安全续传。", false);
    if (!strongTag(part.etag)) {
      if (full) throw new TransferError("文件服务未返回完整文件。", false);
      full = true; checkpoint = undefined; chunks = []; await cache?.clearPartial(key); continue;
    }
    if (checkpoint && (part.etag !== checkpoint.etag || part.total !== checkpoint.total)) {
      if (++versions > 3) throw new TransferError("文件正在变化，请稍后重试。", false);
      checkpoint = undefined; chunks = []; await cache?.clearPartial(key); continue;
    }
    failures = 0;
    if (!validating) {
      chunks.push(reply.data);
      checkpoint = { etag: part.etag, total: part.total, received: part.end + 1, parts: chunks.length, mime: reply.mime, name: reply.name };
      await cache?.appendPartial(key, checkpoint, reply.data);
    }
    if (validating && checkpoint?.received === part.total) {
      const data = new Uint8Array(part.total);
      let offset = 0;
      for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
      progress({ received: data.length, total: data.length, phase: "downloading" });
      return { data, mime: checkpoint.mime, name: checkpoint.name };
    }
  }
}

export async function externalFileRequest(path: string, options: RequestOptions): Promise<BinaryFile> {
  const attempt = new AbortController();
  options.signal?.throwIfAborted();
  const abort = () => attempt.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  const signal = attempt.signal;
  let idle: ReturnType<typeof setTimeout>;
  const progress = () => { clearTimeout(idle); idle = setTimeout(() => attempt.abort(new TransferError("文件传输长时间没有进度。", true)), 180_000); };
  progress();
  try {
    const headers: Record<string, string> = {};
    if (options.range) {
      headers.Range = `bytes=${options.range.start}-${options.range.end}`;
      if (options.range.etag) headers["If-Range"] = options.range.etag;
    }
    const response = await fetch(path, { headers, credentials: "omit", referrerPolicy: "no-referrer", signal });
    progress();
    if (!response.ok) { await response.body?.cancel(); throw new TransferError("无法读取外部文件，请稍后重试。", response.status >= 500, response.status); }
    const encoding = response.headers.get("content-encoding");
    const compressed = Boolean(encoding && encoding.toLowerCase() !== "identity");
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
    const etag = response.headers.get("etag") ?? "";
    if (response.status === 206 && (compressed || !match || !strongTag(etag))) {
      await response.body?.cancel();
      if (!options.range) throw new TransferError("外部文件分段响应无法校验。", false);
      return externalFileRequest(path, { ...options, range: undefined });
    }
    if (Number(response.headers.get("content-length")) > MAX_FILE_BYTES) { await response.body?.cancel(); throw new TransferError("文件超过手机端 100 MB 的读取上限。", false); }
    const chunks: Uint8Array[] = []; let size = 0;
    const reader = response.body?.getReader();
    if (reader) {
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          if (value.length) progress();
          size += value.length;
          if (size > MAX_FILE_BYTES) throw new TransferError("文件超过手机端 100 MB 的读取上限。", false);
          chunks.push(value); options.onProgress?.(size);
        }
      } finally { await reader.cancel().catch(() => {}); }
    } else chunks.push(new Uint8Array(await response.arrayBuffer()));
    const data = new Uint8Array(await new Blob(chunks as BlobPart[]).arrayBuffer());
    const declared = response.headers.get("content-length");
    if (!compressed && declared !== null && Number(declared) !== data.length) throw new TransferError("文件响应中断。", true);
    return { data, mime: response.headers.get("content-type") || "application/octet-stream", name: fileName(path), ...(response.status === 206 && match ? { range: { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]), etag } } : {}) };
  } catch (error) {
    if (attempt.signal.aborted) throw attempt.signal.reason;
    throw error;
  } finally { clearTimeout(idle!); options.signal?.removeEventListener("abort", abort); }
}
