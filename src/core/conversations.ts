import type { Bot, Message, MessagePage } from "./contracts";
import { unreadThreads } from "./attention";

export const replyMessage = (message: Message) => message.role === "bot" && !["activity", "digest", "screen", "compaction"].includes(message.kind);
export const lastReply = (messages: Message[]) => [...messages].reverse().find(replyMessage);
const time = (value?: string | number) => value === undefined ? 0 : new Date(value).getTime() || 0;

export function conversationTasks(bot: Bot) {
  const tasks = new Map(bot.tasks.filter(task => !task.routineRunId).map(task => [task.threadId, task]));
  if (!tasks.has(bot.threadId)) tasks.set(bot.threadId, { threadId: bot.threadId });
  return [...tasks.values()];
}

export const conversationVersion = (bot: Bot, threadId: string) => JSON.stringify([
  bot.tasks.find(task => task.threadId === threadId)?.updatedAt,
  threadId === bot.threadId ? bot.messages : null,
]);

export interface Conversation {
  threadId: string;
  title: string;
  reply?: Message;
  unread: boolean;
  archived: boolean;
  updatedAt: number;
}

export function conversationList(bot: Bot, page: (threadId: string) => MessagePage | undefined): Conversation[] {
  const unread = new Set(unreadThreads(bot).map(task => task.threadId));
  return conversationTasks(bot).map(task => {
    const reply = lastReply(page(task.threadId)?.messages ?? (task.threadId === bot.threadId ? bot.messages : []));
    return { threadId: task.threadId, title: task.title?.trim() || "未命名对话", reply,
      unread: unread.has(task.threadId), archived: Boolean(task.archivedAt), updatedAt: task.updatedAt ?? task.createdAt ?? 0 };
  }).sort((a, b) => Number(a.archived) - Number(b.archived) || b.updatedAt - a.updatedAt || a.threadId.localeCompare(b.threadId));
}

export function latestConversation(conversations: Conversation[], fallback: string): Conversation | undefined {
  return conversations.filter(item => !item.archived && item.reply).sort((a, b) =>
    time(b.reply?.timestamp) - time(a.reply?.timestamp) || b.updatedAt - a.updatedAt || Number(b.threadId === fallback) - Number(a.threadId === fallback))[0]
    ?? conversations.find(item => item.threadId === fallback)
    ?? conversations.find(item => !item.archived) ?? conversations[0];
}
