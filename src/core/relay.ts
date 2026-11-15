import { Buffer } from "buffer";
import { admission, b64u, credentialHash, fromB64u, keyId, psk } from "../desktop/credentials";
import { encodePayload1, isPublicKey, newConn, NoiseError, phoneHello, type PhoneHello, type SessionKeys } from "../desktop/noise";
import { decodeFrame, encodeFrame, Mux } from "../desktop/yamux";
import type { ConnectionDescriptor, SecureVault, WorkspaceConnection, RequestOptions } from "./contracts";

const MAX_RESPONSE = 8 * 1024 * 1024;
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
const text = new TextDecoder();

export function relayUrl(host: string): string {
  if (__FIXTURE__ && /^127\.0\.0\.1:\d+$/.test(host)) return `ws://${host}/fixture-relay/phone`;
  if (!/^(donebot\.cn\/mobile-relay|relay[1-9][0-9]?\.donebot\.cn)$/.test(host)) throw new Error("无法验证中继服务地址。");
  return `wss://${host}/v1/phone`;
}

export async function pinConnection(vault: SecureVault, accountId: string, workspaceId: string, descriptor: ConnectionDescriptor): Promise<void> {
  const publicKey = fromB64u(descriptor.k);
  if (!publicKey || !isPublicKey(publicKey) || fromB64u(descriptor.h)?.length !== 16) throw new Error("设备连接凭据无效。");
  descriptor.r.forEach(relayUrl);
  const key = `donebot.pin.${accountId}.${workspaceId}`;
  const pin = JSON.stringify({ k: descriptor.k, h: descriptor.h });
  const saved = await vault.read(key);
  if (saved && saved !== pin) throw new Error("设备身份发生变化，请在电脑端重新授权这台手机。");
  if (!saved) await vault.write(key, pin);
}

export function decodeHttp(bytes: Uint8Array, binary = false): { status: number; body: unknown } {
  const raw = Buffer.from(bytes);
  const boundary = raw.indexOf("\r\n\r\n");
  if (boundary < 0 || boundary > 32 * 1024) throw new Error("设备返回的消息不完整。");
  const headers = raw.subarray(0, boundary).toString("utf8");
  const status = Number(/^HTTP\/1\.[01] (\d{3}) /.exec(headers)?.[1]);
  if (!status) throw new Error("设备返回了无效响应。");
  let body = raw.subarray(boundary + 4);
  const encoding = /^content-encoding:[ \t]*([^\r\n]+)/im.exec(headers)?.[1].trim().toLowerCase();
  if (encoding && encoding !== "identity") throw new Error("不支持的消息编码。");
  if (/^transfer-encoding:\s*chunked\s*$/im.test(headers)) {
    const chunks: Buffer[] = [];
    while (true) {
      const end = body.indexOf("\r\n");
      if (end < 1) throw new Error("设备响应中断。");
      const sizeText = body.subarray(0, end).toString().split(";")[0];
      if (!/^[0-9a-f]+$/i.test(sizeText)) throw new Error("设备响应格式无效。");
      const size = parseInt(sizeText, 16);
      body = body.subarray(end + 2);
      if (size === 0) break;
      if (body.length < size + 2 || body[size] !== 13 || body[size + 1] !== 10) throw new Error("设备响应中断。");
      chunks.push(body.subarray(0, size)); body = body.subarray(size + 2);
    }
    body = Buffer.concat(chunks);
  } else {
    const length = /^content-length:\s*(\d+)\s*$/im.exec(headers);
    if (length && body.length !== Number(length[1])) throw new Error("设备响应中断。");
  }
  if (!binary) return { status, body: body.length ? JSON.parse(text.decode(body)) : null };
  if (status < 200 || status >= 300) {
    let detail: unknown = null;
    if (body.length <= 64 * 1024 && /^content-type:[ \t]*application\/json\b/im.test(headers)) {
      try { detail = JSON.parse(text.decode(body)); } catch { }
    }
    return { status, body: detail };
  }
  const mime = /^content-type:[ \t]*([^\r\n]+)/im.exec(headers)?.[1].trim() || "application/octet-stream";
  const disposition = /^content-disposition:[ \t]*([^\r\n]+)/im.exec(headers)?.[1] ?? "";
  let name = /filename="([^"]+)"/i.exec(disposition)?.[1] ?? "";
  const encoded = /filename\*=UTF-8''([^;\s]+)/i.exec(disposition)?.[1];
  if (encoded) { try { name = decodeURIComponent(encoded); } catch { } }
  return { status, body: { data: new Uint8Array(body), mime, name } };
}

export function responseError(status: number, body: unknown, binary = false): Error {
  const detail = body && typeof body === "object" && "error" in body ? body.error : undefined;
  if (binary) {
    if (status === 403 && detail === "mobile request refused") return new Error("此电脑或 Cloud 的版本尚不支持此手机操作，请更新后重试。");
    if (status === 404) return new Error("文件已移动或不存在，请让 Bot 重新发送。");
    if (status === 413) return new Error("文件超过手机端的读取上限。");
    if (status === 401) return new Error("连接已失效，请返回列表重新连接。");
    return new Error("未能读取此附件，请重试或让 Bot 重新发送。");
  }
  return new Error(status === 403 ? "连接暂时不可用，请返回列表重新连接。" : status === 409 ? "当前会话暂时无法发送，请稍后重试。" : "设备未能完成请求，请刷新后重试。");
}

interface Pending {
  chunks: Buffer[]; bytes: number; outgoing: Buffer; binary: boolean; limit: number;
  resolve(value: unknown): void; reject(error: Error): void; cleanup(): void; progress(): void;
}

export class RelayConnection implements WorkspaceConnection {
  private keys: SessionKeys | undefined;
  private mux: Mux | undefined;
  private hello: PhoneHello | undefined;
  private pending = new Map<number, Pending>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private pingDeadline: ReturnType<typeof setTimeout> | undefined;
  private ping = 0;
  private drain: ReturnType<typeof setTimeout> | undefined;
  private constructor(private socket: WebSocket, private descriptor: ConnectionDescriptor) {}
  get closed(): boolean { return !this.mux || this.socket.readyState !== WebSocket.OPEN; }

  static async connect(descriptor: ConnectionDescriptor): Promise<RelayConnection> {
    let last: unknown;
    for (const host of descriptor.r) {
      try { return await RelayConnection.dial(descriptor, relayUrl(host)); }
      catch (error) { if (error instanceof NoiseError) throw new Error("无法验证设备的加密身份，请重新授权。"); last = error; }
    }
    throw last instanceof Error ? last : new Error("电脑暂时离线，请确认 DoneBot 正在运行。");
  }
  private static dial(descriptor: ConnectionDescriptor, url: string): Promise<RelayConnection> {
    const hostId = fromB64u(descriptor.h);
    const remoteStatic = fromB64u(descriptor.k);
    if (!hostId || hostId.length !== 16 || !remoteStatic || !isPublicKey(remoteStatic)) return Promise.reject(new Error("设备连接凭据无效。"));
    const hash = credentialHash(descriptor.deviceToken);
    const socket = new WebSocket(url, "omb-relay.v1");
    socket.binaryType = "arraybuffer";
    const connection = new RelayConnection(socket, descriptor);
    return new Promise((resolve, reject) => {
      const fail = (error: Error) => { clearTimeout(deadline); connection.close(); reject(error); };
      const deadline = setTimeout(() => fail(new Error("连接超时，请稍后重试。")), 20_000);
      socket.onopen = () => socket.send(JSON.stringify({ t: "phone", v: 1, hid: descriptor.h, adm: b64u(admission(hash, hostId)) }));
      socket.onmessage = event => {
        try {
          if (!connection.hello) {
            if (typeof event.data !== "string" || JSON.parse(event.data).t !== "ready") throw new Error("无法建立加密连接。");
            const conn = newConn();
            connection.hello = phoneHello({ remoteStatic, psk: psk(hash, keyId(remoteStatic)), transport: 1 }, encodePayload1(conn, "donebot-mobile/1"), b64u(conn));
            socket.send(connection.hello.message1);
          } else if (!connection.keys) {
            if (!(event.data instanceof ArrayBuffer)) throw new NoiseError("handshake_binary");
            connection.keys = connection.hello.finish(new Uint8Array(event.data));
            connection.startMux(); clearTimeout(deadline); resolve(connection);
          } else {
            if (!(event.data instanceof ArrayBuffer)) throw new NoiseError("record_binary");
            const frame = decodeFrame(connection.keys.receive.open(new Uint8Array(event.data)));
            clearTimeout(connection.pingDeadline); connection.pingDeadline = undefined;
            connection.mux!.receive(frame);
          }
        } catch (error) { fail(error instanceof Error ? error : new Error("加密连接已中断。")); }
      };
      socket.onclose = () => fail(new Error("设备已断开连接，请稍后重试。"));
      socket.onerror = () => fail(new Error("无法连接设备，请检查网络。"));
    });
  }
  private startMux(): void {
    this.mux = new Mux("phone", {
      send: frame => this.socket.send(this.keys!.send.seal(encodeFrame(frame))),
      data: (id, data) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        pending.bytes += data.length;
        if (pending.bytes > pending.limit) { this.failRequest(id, new Error(pending.binary ? "文件超过手机端 100 MB 的读取上限。" : "设备返回的消息过大。")); return; }
        pending.progress(); pending.chunks.push(Buffer.from(data)); this.mux!.consumed(id, data.length);
      },
      ended: id => {
        const pending = this.pending.get(id);
        if (!pending) return;
        pending.cleanup(); this.pending.delete(id);
        this.mux!.finish(id);
        try {
          const reply = decodeHttp(Buffer.concat(pending.chunks), pending.binary);
          if (pending.binary && ((reply.body as { data?: Uint8Array })?.data?.length ?? 0) > MAX_FILE_BYTES) throw new Error("文件超过手机端 100 MB 的读取上限。");
          if (reply.status < 200 || reply.status >= 300) throw responseError(reply.status, reply.body, pending.binary);
          pending.resolve(reply.body);
        } catch (error) { pending.reject(error instanceof Error ? error : new Error("设备响应无法读取。")); }
      },
      reset: id => {
        const pending = this.pending.get(id);
        pending?.cleanup(); pending?.reject(new Error("连接中断，请稍后重试。")); this.pending.delete(id);
      },
      writable: id => this.flush(id),
      goAway: () => this.close(),
      pong: value => { if (value === this.ping) { clearTimeout(this.pingDeadline); this.pingDeadline = undefined; } },
    });
    this.timer = setInterval(() => {
      if (this.pingDeadline) return;
      this.mux!.ping(++this.ping);
      this.pingDeadline = setTimeout(() => this.close(), 10_000);
    }, 20_000);
  }
  private flush(id: number): void {
    const pending = this.pending.get(id);
    if (!pending || !this.mux) return;
    while (pending.outgoing.length) {
      if (this.socket.bufferedAmount > 1024 * 1024) {
        this.drain ??= setTimeout(() => { this.drain = undefined; this.pending.forEach((_, key) => this.flush(key)); }, 10);
        return;
      }
      const written = this.mux.write(id, pending.outgoing);
      if (!written) return;
      pending.progress();
      pending.outgoing = pending.outgoing.subarray(written);
    }
  }
  private failRequest(id: number, error: Error): void {
    const pending = this.pending.get(id);
    this.pending.delete(id); pending?.cleanup(); pending?.reject(error); this.mux?.reset(id);
  }
  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    if (!mobileRequestAllowed(options.method ?? "GET", path)) throw new Error("手机端不支持此操作。");
    if (!this.mux || this.socket.readyState !== WebSocket.OPEN) throw new Error("设备已离线，请重新连接。");
    options.signal?.throwIfAborted();
    const body = options.rawBody ? Buffer.from(options.rawBody) : options.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(options.body));
    if (body.length > (options.rawBody ? path.startsWith("/api/files?") ? MAX_FILE_BYTES : 10 * 1024 * 1024 : 128 * 1024)) throw new Error("附件或消息超过大小上限。");
    if (!/^omb_[A-Za-z0-9_-]+$/.test(this.descriptor.deviceToken)) throw new Error("设备授权凭据无效。");
    const contentType = options.rawBody ? options.contentType ?? "application/octet-stream" : "application/json";
    if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(contentType)) throw new Error("附件格式无效。");
    const head = Buffer.from(`${options.method ?? "GET"} ${path} HTTP/1.1\r\nHost: donebot.e2e.invalid\r\nAuthorization: Bearer ${this.descriptor.deviceToken}\r\nContent-Type: ${contentType}\r\nAccept-Encoding: identity\r\nConnection: close\r\nContent-Length: ${body.length}\r\n\r\n`);
    return new Promise<T>((resolve, reject) => {
      const id = this.mux!.open();
      const abort = () => this.failRequest(id, new Error("操作已取消。"));
      const streaming = Boolean(options.responseType || options.rawBody);
      const expired = () => this.failRequest(id, new Error("传输长时间没有进展，请重试。"));
      let timeout = setTimeout(expired, streaming ? 180_000 : 30_000);
      const progress = () => { if (streaming) { clearTimeout(timeout); timeout = setTimeout(expired, 180_000); } };
      const cleanup = () => { clearTimeout(timeout); options.signal?.removeEventListener("abort", abort); };
      this.pending.set(id, { binary: options.responseType === "bytes", limit: options.responseType ? MAX_FILE_BYTES + 1024 * 1024 : MAX_RESPONSE + 32 * 1024, chunks: [], bytes: 0, outgoing: Buffer.concat([head, body]), resolve: value => resolve(value as T), reject, cleanup, progress });
      options.signal?.addEventListener("abort", abort, { once: true });
      this.flush(id);
    });
  }
  close(): void {
    clearInterval(this.timer); clearTimeout(this.pingDeadline); clearTimeout(this.drain);
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(new Error("设备已断开连接。")); }
    this.pending.clear(); this.mux = undefined;
    this.socket.onclose = null; this.socket.onmessage = null; this.socket.onerror = null; this.socket.onopen = null;
    this.socket.close();
  }
}

export function mobileRequestAllowed(method: string, path: string): boolean {
  if (method === "POST" && path.startsWith("/api/files?")) {
    const url = new URL(path, "https://mobile.invalid"), name = url.searchParams.get("name") ?? "";
    return url.pathname === "/api/files" && !url.hash && url.searchParams.size === 2
      && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(url.searchParams.get("uploadId") ?? "")
      && /^[^/\\\x00-\x1f]{1,180}$/.test(name) && name !== "." && name !== "..";
  }
  if (method === "PATCH") return /^\/api\/routines\/[A-Za-z0-9_-]+$/.test(path);
  if (method === "POST") return /^\/api\/(bots|groups)\/[A-Za-z0-9_-]+\/(messages|read)$/.test(path)
    || /^\/api\/(webhooks|app-triggers)\/[A-Za-z0-9_-]+\/enabled$/.test(path)
    || /^\/api\/threads\/[A-Za-z0-9_-]+\/messages\/[A-Za-z0-9_-]+\/file$/.test(path)
    || /^\/api\/attachments\?uploadId=[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(path);
  return method === "GET" && (/^\/api\/(bots\?messages=(?:1|20)|threads\/[A-Za-z0-9_-]+\/messages\?limit=50(?:&before=[A-Za-z0-9_-]+)?)$/.test(path)
    || /^\/api\/(routines|webhooks|app-triggers|connectors\/connected)$/.test(path)
    || /^\/api\/attachments\/[A-Za-z0-9-]+\.(png|jpg|gif|webp)$/.test(path));
}
