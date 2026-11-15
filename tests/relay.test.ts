import { Buffer } from "buffer";
import { Duplex } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { E2ESession } from "../../DoneBot/companion/src/e2e/session.ts";
import { generateKeyPair } from "../../DoneBot/companion/src/e2e/noise.ts";
import { b64u, credentialHash, keyId, psk } from "../../DoneBot/companion/src/e2e/credentials.ts";
import { RelayConnection, mobileRequestAllowed } from "../src/core/relay";

const active: RelayConnection[] = [];
afterEach(() => { active.splice(0).forEach(connection => connection.close()); vi.unstubAllGlobals(); vi.useRealTimers(); });

async function fixture() {
  vi.useFakeTimers();
  const key = generateKeyPair(), deviceToken = "omb_synthetic_transport_test";
  const requests: Array<{ path: string; socket: Duplex }> = [];
  let stalled = false;
  class Socket {
    static OPEN = 1;
    readyState = 1; bufferedAmount = 0;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
    readonly peer = E2ESession.computer({
      transport: {
        send: bytes => { if (!stalled) { const data = Uint8Array.from(bytes).buffer; queueMicrotask(() => this.onmessage?.({ data })); } },
        close: () => { this.readyState = 3; queueMicrotask(() => this.onclose?.()); },
        bufferedAmount: 0, onceDrained: listener => queueMicrotask(listener),
      },
      transportByte: 1, staticKey: key,
      candidates: () => [{ id: "fixture", psk: psk(credentialHash(deviceToken), keyId(key.publicKey)) }],
      connectOrigin: async () => {
        let head = "";
        const socket = new Duplex({ read() {}, write(chunk, _encoding, done) {
          head += chunk.toString();
          if (head.includes("\r\n\r\n") && !requests.some(request => request.socket === socket)) requests.push({ path: head.split(" ")[1], socket });
          done();
        } });
        return socket;
      },
    });
    constructor() { queueMicrotask(() => this.onopen?.()); }
    send(bytes: string | Uint8Array) {
      if (typeof bytes === "string") queueMicrotask(() => this.onmessage?.({ data: '{"t":"ready"}' }));
      else queueMicrotask(() => this.peer.receive(bytes, true));
    }
    close() { this.readyState = 3; this.peer.close(1000); }
  }
  vi.stubGlobal("WebSocket", Socket);
  const connection = await RelayConnection.connect({ v: 1, k: b64u(key.publicKey), h: b64u(Buffer.alloc(16, 7)), r: ["relay1.donebot.cn"], deviceToken });
  active.push(connection);
  const flush = async () => { await vi.advanceTimersByTimeAsync(0); };
  const request = async <T>(path: string, options?: Parameters<RelayConnection["request"]>[1]) => {
    const promise = connection.request<T>(path, options);
    await flush();
    return { promise, socket: requests.at(-1)!.socket };
  };
  return { connection, request, flush, stall: () => { stalled = true; } };
}

it("keeps a progressing encrypted video transfer alive beyond three minutes alongside chat polling", async () => {
  const fx = await fixture();
  const download = await fx.request<{ data: Uint8Array }>("/api/threads/t/messages/m/file", { method: "POST", body: { path: "/video.mp4" }, responseType: "bytes" });
  const chunk = Buffer.alloc(512 * 1024, 7);
  download.socket.push(Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: ${chunk.length * 5}\r\n\r\n`));
  for (let n = 0; n < 5; n++) {
    download.socket.push(chunk); await fx.flush();
    await vi.advanceTimersByTimeAsync(50_000);
    const poll = await fx.request<{ bots: unknown[] }>("/api/bots?messages=20");
    poll.socket.push(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{"bots":[]}')); poll.socket.push(null);
    expect(await poll.promise).toEqual({ bots: [] });
    expect(fx.connection.closed).toBe(false);
  }
  download.socket.push(null);
  expect((await download.promise).data).toEqual(new Uint8Array(Buffer.concat(Array(5).fill(chunk))));
  expect(fx.connection.closed).toBe(false);
});

it("times out only an idle file stream while retaining the authenticated connection", async () => {
  const fx = await fixture();
  const download = await fx.request("/api/threads/t/messages/m/file", { method: "POST", responseType: "bytes" });
  const result = download.promise.catch(error => error as Error);
  await vi.advanceTimersByTimeAsync(180_001);
  expect(await result).toBeInstanceOf(Error);
  expect((await result as Error).message).toContain("没有进展");
  expect(fx.connection.closed).toBe(false);
  const poll = await fx.request("/api/bots?messages=20");
  poll.socket.push(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{"bots":[]}')); poll.socket.push(null);
  expect(await poll.promise).toEqual({ bots: [] });
});

it("detects a silent transport loss so the controller can reconnect", async () => {
  const fx = await fixture(); fx.stall();
  await vi.advanceTimersByTimeAsync(30_001);
  expect(fx.connection.closed).toBe(true);
});

it("accepts only named document uploads with a stable id", () => {
  const path = "/api/files?uploadId=11111111-1111-4111-8111-111111111111&name=";
  expect(mobileRequestAllowed("POST", path + encodeURIComponent("工作说明.pdf"))).toBe(true);
  for (const name of ["", ".", "..", "../secret.pdf", "a\\b.pdf", "a\u0000.pdf", "a".repeat(181)]) expect(mobileRequestAllowed("POST", path + encodeURIComponent(name))).toBe(false);
  expect(mobileRequestAllowed("POST", path + "note.pdf&admin=1")).toBe(false);
});
