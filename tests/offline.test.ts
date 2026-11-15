import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { indexedDBStorage } from "../src/platform/cache";
import { AccountCache, mergeMessagePage } from "../src/core/offline";
import { messageSchema } from "../src/core/contracts";

describe("persistent offline storage", () => {
  it("survives a fresh storage instance and isolates account files and snapshots", async () => {
    const name = `offline-${crypto.randomUUID()}`, first = indexedDBStorage(name);
    const bytes = new Uint8Array([0, 1, 128, 255]);
    await first.writeState("alice", "alice history"); await first.writeState("bob", "bob history");
    await first.writeFile("alice", "same path", { data: bytes, mime: "video/mp4", name: "视频.mp4" });
    await first.writeFile("bob", "same path", { data: new Uint8Array([9]), mime: "application/pdf", name: "private.pdf" });
    const reopened = indexedDBStorage(name);
    expect(await reopened.readState("alice")).toBe("alice history");
    expect(await reopened.readFile("alice", "same path")).toEqual({ data: bytes, mime: "video/mp4", name: "视频.mp4" });
    await reopened.clear("alice");
    expect(await first.readState("alice")).toBeNull(); expect(await first.hasFile("alice", "same path")).toBe(false);
    expect(await first.readState("bob")).toBe("bob history"); expect(await first.hasFile("bob", "same path")).toBe(true);
  });
  it("reports a storage failure and permits retrying the snapshot", async () => {
    const storage = indexedDBStorage(`offline-${crypto.randomUUID()}`), write = storage.writeState;
    let failed = 0;
    const cache = new AccountCache(storage, "account", () => { failed++; });
    const state = { version: 1 as const, bots: [], workspaces: [], sections: {}, conversations: [] };
    storage.writeState = async () => { throw new Error("Disk full"); };
    await cache.save(state); expect(failed).toBe(1);
    storage.writeState = write; await cache.save(state);
    expect(JSON.parse((await storage.readState("account"))!)).toEqual(state);
  });
  it("retains all previously downloaded history when new messages have no overlap", () => {
    const msg = (id: string) => messageSchema.parse({ id, role: "bot", text: id });
    const saved = { messages: [msg("old1"), msg("old2")], hasMore: false };
    const fresh = { messages: [msg("new1"), msg("new2")], hasMore: true };
    expect(mergeMessagePage(saved, fresh).messages.map(message => message.id)).toEqual(["old1", "old2", "new1", "new2"]);
    expect(mergeMessagePage(saved, { messages: [{ ...msg("old2"), text: "edited" }, msg("new1")], hasMore: true }).messages.map(message => message.text)).toEqual(["old1", "edited", "new1"]);
  });
});
