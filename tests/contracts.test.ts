import { describe, expect, it } from "vitest";
import { botSchema, directorySchema, errorMessage } from "../src/core/contracts";
import { viewersDefaultBot, type DefaultBotMark } from "../src/desktop/default-bot";

const base = { id: "donebot", name: "DoneBot", threadId: "main-thread" };

describe("desktop default Bot contract", () => {
  it("accepts and preserves the desktop's workspace and personal default Bot objects", () => {
    const place: DefaultBotMark = {};
    const personal: DefaultBotMark = { person: "member@donebot.test" };
    const directory = directorySchema.parse({ bots: [
      { ...base, defaultBot: place, chiefOfStaff: true },
      { ...base, id: "personal", defaultBot: personal },
      { ...base, id: "ordinary" },
    ] });
    expect(directory.bots.map(bot => bot.defaultBot)).toEqual([place, personal, undefined]);
    expect(viewersDefaultBot(directory.bots, "MEMBER@donebot.test")?.id).toBe("personal");
    expect(viewersDefaultBot(directory.bots, "other@donebot.test")?.id).toBe("donebot");
  });
  it("restores boolean markers from older mobile cache snapshots as desktop objects", () => {
    expect(botSchema.parse({ ...base, defaultBot: true }).defaultBot).toEqual({});
    expect(botSchema.parse({ ...base, defaultBot: false }).defaultBot).toBeUndefined();
    const persisted = JSON.parse(JSON.stringify(botSchema.parse({ ...base, defaultBot: { person: "member@donebot.test" } })));
    expect(botSchema.parse(persisted).defaultBot).toEqual({ person: "member@donebot.test" });
  });
  it("shows a readable data error without serializing validation internals", () => {
    const invalid = directorySchema.safeParse({ bots: [{ ...base, defaultBot: "invalid" }] });
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(errorMessage(invalid.error)).toContain("数据暂不兼容");
      expect(errorMessage(invalid.error)).not.toMatch(/invalid_type|defaultBot|expected|path/);
    }
    expect(errorMessage(new Error("设备离线"))).toBe("设备离线");
  });
});

describe("desktop mascot expression contract", () => {
  it("accepts named desktop expressions alongside numeric cache entries without dropping bots", () => {
    const expressions = ["proud", "happy", "working", "future-expression", 7, null, undefined];
    const reply = directorySchema.parse({ bots: expressions.map((mascotExpression, index) => ({ ...base, id: `bot-${index}`, mascotExpression })) });
    expect(reply.bots.map(bot => bot.mascotExpression)).toEqual(expressions);
    expect(directorySchema.parse(JSON.parse(JSON.stringify(reply))).bots).toHaveLength(expressions.length);
  });
});
