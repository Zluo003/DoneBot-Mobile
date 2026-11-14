import { Buffer } from "buffer";
import { admission, b64u, credentialHash, fromB64u, keyId, psk } from "../desktop/credentials";
import { encodePayload1, isPublicKey, newConn, NoiseError, phoneHello, type PhoneHello, type SessionKeys } from "../desktop/noise";
import { decodeFrame, encodeFrame, Mux } from "../desktop/yamux";
import type { ConnectionDescriptor, SecureVault, WorkspaceConnection } from "./contracts";

const MAX_RESPONSE = 8 * 1024 * 1024;
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

export function decodeHttp(bytes: Uint8Array): { status: number; body: unknown } {
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
  return { status, body: body.length ? JSON.parse(text.decode(body)) : null };
}

interface Pending {
  chunks: Buffer[]; bytes: number; outgoing: Buffer;
  resolve(value: unknown): void; reject(error: Error): void; cleanup(): void;
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
            connection.mux!.receive(decodeFrame(connection.keys.receive.open(new Uint8Array(event.data))));
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
        if (pending.bytes > MAX_RESPONSE) { this.mux!.reset(id); return; }
        pending.chunks.push(Buffer.from(data)); this.mux!.consumed(id, data.length);
      },
      ended: id => {
        const pending = this.pending.get(id);
        if (!pending) return;
        pending.cleanup(); this.pending.delete(id);
        this.mux!.finish(id);
        try {
          const reply = decodeHttp(Buffer.concat(pending.chunks));
          if (reply.status < 200 || reply.status >= 300) throw new Error(reply.status === 403 ? "这台手机没有访问权限，请在电脑端检查授权。" : reply.status === 409 ? "当前会话暂时无法发送，请稍后重试。" : "设备未能完成请求，请刷新后重试。");
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
      pending.outgoing = pending.outgoing.subarray(written);
    }
  }
  async request<T>(path: string, options: { method?: "GET" | "POST"; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
    const allowed = options.method === "POST" ? /^\/api\/bots\/[A-Za-z0-9_.:-]+\/(messages|read)$/ : /^\/api\/(bots\?messages=1|threads\/[A-Za-z0-9_.:-]+\/messages\?limit=50(?:&before=[A-Za-z0-9_.:%-]+)?)$/;
    if (!allowed.test(path)) throw new Error("手机端不支持此操作。");
    if (!this.mux || this.socket.readyState !== WebSocket.OPEN) throw new Error("设备已离线，请重新连接。");
    options.signal?.throwIfAborted();
    const body = options.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(options.body));
    if (body.length > 128 * 1024) throw new Error("消息过长，请缩短后发送。");
    if (!/^omb_[A-Za-z0-9_-]+$/.test(this.descriptor.deviceToken)) throw new Error("设备授权凭据无效。");
    const head = Buffer.from(`${options.method ?? "GET"} ${path} HTTP/1.1\r\nHost: donebot.e2e.invalid\r\nAuthorization: Bearer ${this.descriptor.deviceToken}\r\nContent-Type: application/json\r\nAccept-Encoding: identity\r\nConnection: close\r\nContent-Length: ${body.length}\r\n\r\n`);
    return new Promise<T>((resolve, reject) => {
      const id = this.mux!.open();
      const abort = () => this.mux?.reset(id);
      const timeout = setTimeout(abort, 30_000);
      const cleanup = () => { clearTimeout(timeout); options.signal?.removeEventListener("abort", abort); };
      this.pending.set(id, { chunks: [], bytes: 0, outgoing: Buffer.concat([head, body]), resolve: value => resolve(value as T), reject, cleanup });
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
