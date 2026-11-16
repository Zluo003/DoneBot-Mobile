import { describe, expect, it } from "vitest";
import { botSchema, messageSchema, type Bot } from "../src/core/contracts";
import { conversationList, latestConversation } from "../src/core/conversations";

const bot = (patch: object = {}): Bot => ({ ...botSchema.parse({ id: "bot", name: "Bot", threadId: "main", ...patch }), workspace: { id: "computer", name: "Computer", kind: "computer", online: true, provisioned: true } });
const message = (id: string, at: number, patch: object = {}) => messageSchema.parse({ id, at, role: "bot", ...patch });

describe("mobile conversation directory", () => {
  it("selects the latest Bot reply rather than a newer user message, internal activity or archived reply", () => {
    const item = bot({ tasks: [{ threadId: "main", title: "原对话", updatedAt: 500 }, { threadId: "other", title: "另一段工作", updatedAt: 300, unread: true }, { threadId: "archive", title: "已归档", archivedAt: 600, updatedAt: 600 }] });
    const pages = new Map([
      ["main", [message("reply", 100), message("user", 500, { role: "user" }), message("tool", 550, { kind: "activity" })]],
      ["other", [message("new-reply", 300, { text: "完成工作" })]], ["archive", [message("archived-reply", 600)]],
    ]);
    const list = conversationList(item, threadId => ({ messages: pages.get(threadId) ?? [], hasMore: false }));
    expect(latestConversation(list, "main")).toMatchObject({ threadId: "other", title: "另一段工作", unread: true });
    expect(list.at(-1)?.archived).toBe(true);
  });

  it("retains unnamed and empty conversations, filters automation runs, and falls back to the active conversation", () => {
    const list = conversationList(bot({ tasks: [{ threadId: "empty" }, { threadId: "routine", routineRunId: "run" }] }), () => undefined);
    expect(list.map(item => item.threadId)).toEqual(["empty", "main"]);
    expect(list[0].title).toBe("未命名对话");
    expect(latestConversation(list, "main")?.threadId).toBe("main");
  });

  it("treats an attachment-only Bot reply as a reply and preserves the active conversation on equal timestamps", () => {
    const item = bot({ tasks: [{ threadId: "main" }, { threadId: "other" }] });
    const list = conversationList(item, () => ({ messages: [message("image", 100, { text: "", attachments: [{ kind: "image", path: "/image.png", mime: "image/png" }] })], hasMore: false }));
    expect(latestConversation(list, "main")?.threadId).toBe("main");
  });
});
