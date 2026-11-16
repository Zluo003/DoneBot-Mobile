import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { downloadFileSegments, externalFileRequest, FILE_SEGMENT_BYTES } from "../src/core/file-download";
import { AccountCache } from "../src/core/offline";
import { indexedDBStorage } from "../src/platform/cache";
import type { BinaryFile, RequestOptions } from "../src/core/contracts";
import { TransferError } from "../src/core/transfer-error";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const bytes = new Uint8Array(FILE_SEGMENT_BYTES * 2 + 37).map((_, i) => i % 251);
function segment(options: RequestOptions, source = bytes, etag = '"version-1"', mime = "video/mp4"): BinaryFile {
  const start = options.range?.start ?? 0, end = Math.min(options.range?.end ?? source.length - 1, source.length - 1);
  if (options.range?.etag && options.range.etag !== etag) return { data: source, mime, name: "asset", };
  return { data: source.slice(start, end + 1), mime, name: "asset", range: { start, end, total: source.length, etag } };
}
function fixture() {
  const storage = indexedDBStorage(`download-${crypto.randomUUID()}`);
  const cache = new AccountCache(storage, "account", () => {});
  const transfer = new AbortController();
  const progress = vi.fn();
  const options = { key: "message-file", cache, signal: transfer.signal, ready: async () => {}, progress };
  return { storage, cache, transfer, progress, options };
}

it.each(["image/png", "video/mp4", "audio/mpeg", "application/pdf"])("resumes %s after interruption and verifies every byte", async mime => {
  const fx = fixture(); let interrupted = false;
  const request = vi.fn(async (options: RequestOptions) => {
    if (options.range!.start === FILE_SEGMENT_BYTES && !interrupted) { interrupted = true; throw new TransferError("disconnected", true); }
    return segment(options, bytes, '"version-1"', mime);
  });
  const reading = downloadFileSegments({ ...fx.options, request });
  await vi.waitFor(() => expect(fx.progress).toHaveBeenCalledWith(expect.objectContaining({ phase: "reconnecting", received: FILE_SEGMENT_BYTES })));
  expect((await fx.storage.readPartial("account", "message-file"))?.checkpoint.received).toBe(FILE_SEGMENT_BYTES);
  const result = await reading;
  expect(result.data).toEqual(bytes); expect(result.mime).toBe(mime);
  expect(request.mock.calls.map(([options]) => options.range?.start)).toEqual([0, FILE_SEGMENT_BYTES, FILE_SEGMENT_BYTES, FILE_SEGMENT_BYTES * 2, 0]);
});

it("restores a checkpoint after a fresh app instance and keeps it isolated by account", async () => {
  const fx = fixture();
  const stopped = downloadFileSegments({ ...fx.options, request: async options => {
    if (options.range!.start) throw new TransferError("stopped", false);
    return segment(options);
  } });
  await expect(stopped).rejects.toThrow("stopped");
  await fx.cache.close();
  expect(await new AccountCache(fx.storage, "another-account", () => {}).partial("message-file")).toBeNull();
  const request = vi.fn(async (options: RequestOptions) => segment(options));
  const resumed = await downloadFileSegments({ ...fx.options, cache: new AccountCache(fx.storage, "account", () => {}), request });
  expect(request.mock.calls[0][0].range).toMatchObject({ start: FILE_SEGMENT_BYTES, etag: '"version-1"' });
  expect(resumed.data).toEqual(bytes);
  await fx.storage.clearPartial("account", "message-file");
  expect(await fx.storage.readPartial("account", "message-file")).toBeNull();
});

it("restarts safely when If-Range returns a replacement file", async () => {
  const fx = fixture(), replacement = new Uint8Array(FILE_SEGMENT_BYTES + 11).fill(97);
  let calls = 0;
  const result = await downloadFileSegments({ ...fx.options, request: async options => ++calls === 1 ? segment(options) : segment(options, replacement, '"version-2"') });
  expect(result.data).toEqual(replacement);
});

it("validates an already complete checkpoint before returning it after restart", async () => {
  const fx = fixture();
  await downloadFileSegments({ ...fx.options, request: async options => segment(options) });
  const request = vi.fn(async () => { throw new TransferError("revoked", false, 401); });
  await expect(downloadFileSegments({ ...fx.options, request })).rejects.toThrow("revoked");
  expect(request).toHaveBeenCalledTimes(1);
});

it.each([401, 403, 404, 413])("does not retry status %s or return partial bytes", async status => {
  const fx = fixture(), request = vi.fn(async () => { throw new TransferError("refused", false, status); });
  await expect(downloadFileSegments({ ...fx.options, request })).rejects.toThrow("refused");
  expect(request).toHaveBeenCalledTimes(1);
});

it("supports older servers and empty files using a complete response", async () => {
  const fx = fixture();
  const result = await downloadFileSegments({ ...fx.options, request: async () => ({ data: new Uint8Array(), mime: "application/pdf", name: "empty.pdf" }) });
  expect(result.data.length).toBe(0);
});

it("bounds repeated stalled retries, retaining its checkpoint for a manual retry", async () => {
  vi.useFakeTimers(); const fx = fixture();
  const request = vi.fn(async () => { throw new TransferError("stalled", true); });
  const result = expect(downloadFileSegments({ ...fx.options, cache: null, request })).rejects.toThrow("保留下载进度");
  await vi.advanceTimersByTimeAsync(40_000); await result;
  expect(request).toHaveBeenCalledTimes(6);
});

it("rejects overlapping or truncated segments instead of concatenating them", async () => {
  const fx = fixture();
  await expect(downloadFileSegments({ ...fx.options, request: async options => ({ ...segment(options), data: new Uint8Array([1]) }) })).rejects.toThrow("无法安全续传");
});

it("restarts when the final version check detects a write during the last segment", async () => {
  const fx = fixture();
  const original = bytes.subarray(0, 43), replacement = new Uint8Array(43).fill(87);
  let calls = 0;
  const result = await downloadFileSegments({ ...fx.options, request: async options => ++calls === 1 ? segment(options, original) : segment(options, replacement, '"version-2"') });
  expect(result.data).toEqual(replacement);
  expect(calls).toBe(2);
});

it("downloads a complete copy when an external range has no strong version tag", async () => {
  const fx = fixture();
  const request = vi.fn(async (options: RequestOptions) => options.range ? segment(options, bytes, "W/weak") : { data: bytes, mime: "video/mp4", name: "film.mp4" });
  expect((await downloadFileSegments({ ...fx.options, request })).data).toEqual(bytes);
  expect(request.mock.calls.map(([options]) => options.range?.start)).toEqual([0, undefined]);
});

it("falls back to a complete request for a zero-length range response", async () => {
  const fx = fixture();
  const request = vi.fn(async (options: RequestOptions) => {
    if (options.range) throw new TransferError("range unsatisfiable", false, 416);
    return { data: new Uint8Array(), mime: "application/pdf", name: "empty.pdf" };
  });
  expect((await downloadFileSegments({ ...fx.options, request })).data.length).toBe(0);
  expect(request).toHaveBeenCalledTimes(2);
});

it("keeps the last checkpoint when a complete cache write fails", async () => {
  const fx = fixture();
  await downloadFileSegments({ ...fx.options, request: async options => segment(options) });
  fx.storage.writeFile = async () => { throw new Error("disk full"); };
  expect(await fx.cache.putFile("message-file", { data: bytes, mime: "video/mp4", name: "film" })).toBe(false);
  expect((await fx.storage.readPartial("account", "message-file"))?.checkpoint.received).toBe(bytes.length);
});

it("resumes external HTTPS files with Range while omitting DoneBot credentials", async () => {
  const fx = fixture(), source = bytes.subarray(0, FILE_SEGMENT_BYTES + 19);
  const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
    const headers = options.headers as Record<string, string>;
    const match = /bytes=(\d+)-(\d+)/.exec(headers.Range)!;
    const start = Number(match[1]), end = Math.min(Number(match[2]), source.length - 1);
    expect(options.credentials).toBe("omit"); expect(options.referrerPolicy).toBe("no-referrer");
    expect(headers.Authorization).toBeUndefined();
    return new Response(source.slice(start, end + 1), { status: 206, headers: { "content-type": "video/mp4", "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${source.length}`, etag: '"external-version"' } });
  });
  vi.stubGlobal("fetch", fetcher);
  const result = await downloadFileSegments({ ...fx.options, request: options => externalFileRequest("https://media.example.test/video.mp4", options) });
  expect(result.data).toEqual(source);
  expect(fetcher.mock.calls.map(([, options]) => (options.headers as Record<string, string>).Range)).toEqual([`bytes=0-${FILE_SEGMENT_BYTES - 1}`, `bytes=${FILE_SEGMENT_BYTES}-${FILE_SEGMENT_BYTES * 2 - 1}`, "bytes=0-0"]);
  expect((fetcher.mock.calls[1][1].headers as Record<string, string>)["If-Range"]).toBe('"external-version"');
});

it("ignores encoded Content-Length for browser-decoded external documents", async () => {
  const fx = fixture(), decoded = new TextEncoder().encode("decoded document");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(decoded, { headers: { "content-type": "text/plain", "content-encoding": "gzip", "content-length": "10" } })));
  const result = await downloadFileSegments({ ...fx.options, request: options => externalFileRequest("https://media.example.test/doc.txt", options) });
  expect(result.data).toEqual(decoded);
});

it("falls back to complete external downloads when CORS hides range or version headers", async () => {
  const source = new Uint8Array([1, 2, 3]);
  const fetcher = vi.fn(async (_url: string, options: RequestInit) => new Response(source, { status: (options.headers as Record<string, string>).Range ? 206 : 200, headers: { "content-type": "application/pdf" } }));
  vi.stubGlobal("fetch", fetcher);
  const result = await externalFileRequest("https://media.example.test/file.pdf", { range: { start: 1, end: 2 }, signal: new AbortController().signal });
  expect(result.data).toEqual(source); expect(result.range).toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1][1].headers).toEqual({});
});
