import { describe, expect, it, vi } from "vitest";
import { readThread, UnreadMessages, unreadThreads } from "../src/core/attention";
import { botSchema, messageSchema, type Bot } from "../src/core/contracts";

const bot = (patch: object = {}): Bot => ({ ...botSchema.parse({ id: "bot", name: "Bot", threadId: "main", unread: true, ...patch }), workspace: { id: "computer", name: "Computer", kind: "computer", online: true, provisioned: true } });
const message = (id: string, patch: object = {}) => messageSchema.parse({ id, role: "bot", ...patch });

describe("unread message totals", () => {
  it("walks beyond the directory page to the read marker and excludes user and internal events", async () => {
    const newest = Array.from({ length: 20 }, (_, i) => message(`new-${i}`));
    const read = vi.fn(async () => ({ messages: [message("old"), message("read"), message("reply"), message("file", { attachments: [{ kind: "file", path: "/file.pdf", mime: "application/pdf" }] }),
      message("user", { role: "user" }), ...["activity", "digest", "screen", "compaction"].map(kind => message(kind, { kind }))], hasMore: true }));
    const total = await new UnreadMessages().count(bot({ messages: newest, hasMore: true, tasks: [{ threadId: "main", unread: true, lastReadMessageId: "read" }] }), read, () => true);
    expect(total).toBe(22);
    expect(read).toHaveBeenCalledExactlyOnceWith("main", "new-0");
  });

  it("sums separate unread tasks once and keeps the others unread when opening one", async () => {
    const item = bot({ tasks: [{ threadId: "main", unread: false }, { threadId: "other", unread: true, lastReadMessageId: "read" }, { threadId: "third", unread: true }] });
    const read = vi.fn(async (threadId: string) => ({ messages: threadId === "other" ? [message("read"), message("one"), message("two")] : [message("three")], hasMore: false }));
    expect(await new UnreadMessages().count(item, read, () => true)).toBe(3);
    expect(read.mock.calls.map(([id]) => id)).toEqual(["other", "third"]);
    const opened = readThread(item, "other");
    expect(opened.unread).toBe(true);
    expect(unreadThreads(opened).map(task => task.threadId)).toEqual(["third"]);
    expect(readThread(opened, "third")).toMatchObject({ unread: false, unreadCount: 0 });
  });

  it("uses a group's read marker and does not double count its active task", async () => {
    const item = bot({ conversationKind: "group", lastReadMessageId: "read", hasMore: false, messages: [message("old"), message("read"), message("new")], tasks: [{ threadId: "main", unread: true }] });
    const read = vi.fn();
    expect(await new UnreadMessages().count(item, read, () => true)).toBe(1);
    expect(read).not.toHaveBeenCalled();
  });

  it("reuses unchanged totals, recounts after messages or cursors change, and isolates workspaces", async () => {
    const counter = new UnreadMessages();
    const read = vi.fn(async () => ({ messages: [message("one"), message("two")], hasMore: false }));
    let item = bot();
    expect(await counter.count(item, read, () => true)).toBe(2);
    expect(await counter.count(item, read, () => true)).toBe(2);
    expect(read).toHaveBeenCalledTimes(1);
    item = bot({ tasks: [{ threadId: "main", unread: true, lastReadMessageId: "one" }] });
    expect(await counter.count(item, read, () => true)).toBe(1);
    item = { ...item, workspace: { ...item.workspace, id: "cloud" } };
    expect(await counter.count(item, read, () => true)).toBe(1);
    expect(read).toHaveBeenCalledTimes(3);
    item = { ...item, messages: [message("two")] };
    await counter.count(item, read, () => true);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("retries failed reads and never returns a partial or cancelled count", async () => {
    const counter = new UnreadMessages(), item = bot();
    const read = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ messages: [message("new")], hasMore: false });
    await expect(counter.count(item, read, () => true)).rejects.toThrow("offline");
    expect(await counter.count(item, read, () => true)).toBe(1);
    counter.clear();
    let active = true;
    read.mockImplementation(async () => { active = false; return { messages: [message("new")], hasMore: false }; });
    await expect(counter.count(item, read, () => active)).rejects.toThrow("取消");
  });

  it("keeps a missing read marker unresolved instead of treating old history as unread", async () => {
    const read = vi.fn(async () => ({ messages: [message("old"), message("new")], hasMore: false }));
    await expect(new UnreadMessages().count(bot({ lastReadMessageId: "missing" }), read, () => true)).rejects.toThrow("已读消息");
  });

  it("rechecks secondary threads without update metadata after thirty seconds", async () => {
    vi.useFakeTimers();
    try {
      const counter = new UnreadMessages(), item = bot({ tasks: [{ threadId: "main", unread: false }, { threadId: "other", unread: true }] });
      const read = vi.fn(async () => ({ messages: [message("one")], hasMore: false }));
      expect(await counter.count(item, read, () => true)).toBe(1);
      read.mockResolvedValue({ messages: [message("one"), message("two")], hasMore: false });
      await vi.advanceTimersByTimeAsync(31_000);
      expect(await counter.count(item, read, () => true)).toBe(2);
      expect(read).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
});
