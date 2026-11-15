import { describe, expect, it } from "vitest";
import { Buffer } from "buffer";
import vectors from "./fixtures/e2e-v1.json";
import { admission, b64u, credentialHash, keyId, psk } from "../src/desktop/credentials";
import { CipherState, keyPairFromPrivate, phoneHello, RecordCipher } from "../src/desktop/noise";
import { decodeFrame, encodeFrame } from "../src/desktop/yamux";
import { decodeHttp, pinConnection, relayUrl, responseError } from "../src/core/relay";

const bytes = (hex: string) => Buffer.from(hex, "hex");
describe("desktop wire compatibility", () => {
  it("derives the original device admission and session secrets", () => {
    const transport = keyPairFromPrivate(bytes(vectors.inputs.transportPrivate));
    expect(transport.publicKey.toString("hex")).toBe(vectors.V1.transportPublic);
    for (const credential of vectors.V1.credentials) {
      const hash = credentialHash(credential.token);
      expect(hash.toString("hex")).toBe(credential.credHash);
      expect(psk(hash, keyId(transport.publicKey)).toString("hex")).toBe(credential.psk);
      expect(b64u(admission(hash, bytes(vectors.inputs.hostId)))).toBe(credential.admB64u);
    }
  });
  for (const vector of [vectors.V2, vectors.V3]) {
    it(`matches the desktop Noise handshake for transport ${vector.transport}`, () => {
      const hello = phoneHello({
        remoteStatic: bytes(vectors.V1.transportPublic), psk: bytes(vectors.V1.credentials.find(credential => credential.name === vector.psk)!.psk), transport: vector.transport as 1 | 2,
        ephemeral: keyPairFromPrivate(bytes(vectors.inputs.phoneEphemeralPrivate)),
      }, Buffer.from(vectors.inputs.payload1), vectors.inputs.connB64u);
      expect(hello.message1.toString("hex")).toBe(vector.message1);
      const keys = hello.finish(bytes(vector.message2));
      expect(keys.kPc.toString("hex")).toBe(vector.kPc);
      expect(keys.kCp.toString("hex")).toBe(vector.kCp);
      expect(keys.handshakeHash.toString("hex")).toBe(vector.handshakeHash);
      expect(() => hello.finish(bytes(vector.message2))).toThrow();
    });
  }
  it("matches encrypted records and rejects tampering and replays", () => {
    for (const direction of ["pc", "cp"]) {
      const key = bytes(direction === "pc" ? vectors.V4.kPc : vectors.V4.kCp);
      const sender = new RecordCipher(new CipherState(key));
      const receiver = new RecordCipher(new CipherState(key));
      for (const record of vectors.V4.records.filter(record => record.direction === direction)) {
        expect(sender.seal(bytes(record.frame)).toString("hex")).toBe(record.record);
        expect(receiver.open(bytes(record.record)).toString("hex")).toBe(record.frame);
        expect(encodeFrame(decodeFrame(bytes(record.frame))).toString("hex")).toBe(record.frame);
      }
    }
    const record = bytes(vectors.V4.records[0].record);
    const receiver = new RecordCipher(new CipherState(bytes(vectors.V4.kPc)));
    receiver.open(record);
    expect(() => receiver.open(record)).toThrow();
    record[1] ^= 1;
    expect(() => new RecordCipher(new CipherState(bytes(vectors.V4.kPc))).open(record)).toThrow();
  });
  it("pins both host identity and public key, and rejects original service relays", async () => {
    const values = new Map<string, string>();
    const vault = { read: async (key: string) => values.get(key) ?? null, write: async (key: string, value: string) => { values.set(key, value); }, remove: async () => {} };
    const descriptor = { v: 1 as const, k: vectors.V1.transportPublicB64u, h: vectors.V1.hostIdB64u, r: ["relay1.donebot.cn"], deviceToken: vectors.inputs.deviceToken };
    await pinConnection(vault, "one", "computer", descriptor);
    await pinConnection(vault, "one", "computer", descriptor);
    await expect(pinConnection(vault, "one", "computer", { ...descriptor, h: b64u(Buffer.alloc(16)) })).rejects.toThrow("身份发生变化");
    expect(() => relayUrl("relay1.openmausbot.com")).toThrow();
    expect(() => relayUrl("relay1.donebot.cn.attacker.test")).toThrow();
    expect(() => relayUrl("127.0.0.1:8888")).toThrow();
    expect(relayUrl("donebot.cn/mobile-relay")).toBe("wss://donebot.cn/mobile-relay/v1/phone");
    for (const host of ["donebot.cn/mobile-relay/../api", "donebot.cn/mobile-relay?redirect=x", "donebot.cn/mobile-relay.attacker.test", "donebot.cn:18080/mobile-relay"]) {
      expect(() => relayUrl(host)).toThrow();
    }
  });
});

describe("HTTP carried inside E2E", () => {
  it("reads chunked responses without treating chunk markers as JSON", () => {
    const body = '{"ok":true}';
    expect(decodeHttp(Buffer.from(`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${body.length.toString(16)}\r\n${body}\r\n0\r\n\r\n`))).toEqual({ status: 200, body: { ok: true } });
  });
  it("rejects truncated responses and compressed bytes", () => {
    expect(() => decodeHttp(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\n{}'))).toThrow("中断");
    expect(() => decodeHttp(Buffer.from('HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\n\r\n{}'))).toThrow("编码");
  });
});

describe("binary files over the encrypted connection", () => {
  it("preserves arbitrary bytes, MIME and UTF-8 download names", () => {
    const data = Buffer.from([0, 255, 13, 10, 128, 0]);
    const reply = decodeHttp(Buffer.concat([Buffer.from("HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Disposition: attachment; filename*=UTF-8''%E8%A7%86%E9%A2%91.mp4\r\nContent-Length: 6\r\n\r\n"), data]), true);
    expect(reply).toEqual({ status: 200, body: { data: new Uint8Array(data), mime: "video/mp4", name: "视频.mp4" } });
  });
  it("reads chunked binary without JSON decoding and retains HTTP failures", () => {
    const reply = decodeHttp(Buffer.from("HTTP/1.1 200 OK\r\nContent-Type: audio/wav\r\nTransfer-Encoding: chunked\r\n\r\n3\r\n\x00\xffA\r\n2\r\nBC\r\n0\r\n\r\n", "latin1"), true);
    expect((reply.body as { data: Uint8Array }).data).toEqual(new Uint8Array([0, 255, 65, 66, 67]));
    expect(decodeHttp(Buffer.from("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n"), true).status).toBe(403);
  });
  it("distinguishes an outdated mobile route from an unavailable file without exposing server paths", () => {
    const body = JSON.stringify({ error: "mobile request refused" });
    const reply = decodeHttp(Buffer.from(`HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`), true);
    expect(reply.body).toEqual({ error: "mobile request refused" });
    expect(responseError(reply.status, reply.body, true).message).toContain("版本尚不支持");
    expect(responseError(403, { error: "outside /private/secret" }, true).message).toBe("未能读取此附件，请重试或让 Bot 重新发送。");
    expect(responseError(404, null, true).message).toContain("已移动或不存在");
    const invalid = decodeHttp(Buffer.from("HTTP/1.1 503 Unavailable\r\nContent-Type: application/json\r\nContent-Length: 6\r\n\r\nbroken"), true);
    expect(invalid.body).toBeNull();
  });
});
