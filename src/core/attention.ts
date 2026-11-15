import { botKey, type Bot, type Message, type MessagePage } from "./contracts";

export function unreadThreads(bot: Bot) {
  const threads = new Map(bot.tasks.filter(task => task.unread).map(task => [task.threadId, task]));
  const main = bot.tasks.find(task => task.threadId === bot.threadId);
  if (bot.unread && (bot.conversationKind === "group" || !main || main.unread === undefined)) {
    threads.set(bot.threadId, { threadId: bot.threadId, lastReadMessageId: bot.lastReadMessageId ?? main?.lastReadMessageId });
  }
  return [...threads.values()];
}

export function readThread(bot: Bot, threadId: string): Bot {
  const remaining = unreadThreads(bot).filter(task => task.threadId !== threadId);
  return { ...bot, unread: remaining.length > 0, unreadCount: remaining.length ? undefined : 0,
    tasks: bot.tasks.map(task => task.threadId === threadId ? { ...task, unread: false } : task) };
}

export const attentionVersion = (bot: Bot) => JSON.stringify([bot.unread, unreadThreads(bot), bot.messages.map(message => [message.id, message.role, message.kind])]);

export class UnreadMessages {
  private counts = new Map<string, { version: string; count: number; at: number }>();
  clear(): void { this.counts.clear(); }

  async count(bot: Bot, read: (threadId: string, before?: string) => Promise<MessagePage>, current: () => boolean): Promise<number> {
    let total = 0;
    for (const task of unreadThreads(bot)) {
      if (!current()) throw new Error("未读同步已取消");
      const main = task.threadId === bot.threadId;
      const version = JSON.stringify([task.lastReadMessageId, task.updatedAt, main ? bot.messages.map(message => [message.id, message.role, message.kind]) : null]);
      const key = `${botKey(bot)}/${task.threadId}`, cached = this.counts.get(key);
      if (cached?.version === version && (main || task.updatedAt !== undefined || Date.now() - cached.at < 30_000)) {
        total += cached.count; continue;
      }
      let page: MessagePage = main && bot.hasMore !== undefined ? { messages: bot.messages, hasMore: bot.hasMore } : await read(task.threadId);
      const messages = new Map<string, Message>();
      let before: string | undefined;
      while (true) {
        if (!current()) throw new Error("未读同步已取消");
        const marker = page.messages.findIndex(message => message.id === task.lastReadMessageId);
        for (const message of page.messages.slice(marker + 1)) messages.set(message.id, message);
        if (marker >= 0) break;
        if (!page.hasMore) {
          if (task.lastReadMessageId) throw new Error("暂时无法定位已读消息");
          break;
        }
        const next = page.messages[0]?.id;
        if (!next || next === before) throw new Error("暂时无法完整同步未读消息");
        before = next;
        page = await read(task.threadId, before);
      }
      const count = [...messages.values()].filter(message => message.role === "bot" && !["activity", "digest", "screen", "compaction"].includes(message.kind)).length;
      this.counts.set(key, { version, count, at: Date.now() });
      total += count;
    }
    return total;
  }
}
