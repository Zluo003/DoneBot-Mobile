import { z } from "zod";
import { botSchema, messagePageSchema, workspaceSchema, type BinaryFile, type Bot, type Message, type MessagePage, type OfflineStorage, type Workspace } from "./contracts";

const snapshotSchema = z.object({
  version: z.literal(1), workspaces: z.array(workspaceSchema),
  bots: z.array(botSchema.extend({ workspace: workspaceSchema })),
  sections: z.record(z.string(), z.array(z.string())).default({}),
  conversations: z.array(z.tuple([z.string(), messagePageSchema])),
});
export type OfflineSnapshot = z.infer<typeof snapshotSchema>;
export const cachedFileKey = (bot: Bot, messageId: string | null, path: string) => JSON.stringify([bot.workspace.id, bot.id, messageId === null ? null : bot.threadId, messageId, path]);

export function mergeMessagePage(previous: MessagePage | undefined, page: MessagePage, older = false): MessagePage {
  if (!previous?.messages.length || (!older && !page.hasMore)) return page;
  const ordered = older ? [...page.messages, ...previous.messages] : [...previous.messages, ...page.messages];
  // Map preserves chronological insertion order while replacing edited/streaming messages.
  return { messages: [...new Map(ordered.map(message => [message.id, message])).values()], hasMore: older ? page.hasMore : previous.hasMore };
}

const storedMessage = ({ id, role, text, timestamp, kind, sendId, attachments, from }: Message) => ({ id, role, text, timestamp, kind, sendId, attachments, from });
export function offlineSnapshot(workspaces: Workspace[], bots: Bot[], conversations: Map<string, MessagePage>, sections: Record<string, string[]> = {}): OfflineSnapshot {
  return {
    version: 1, workspaces, sections,
    bots: bots.map(bot => ({ ...botSchema.strip().parse(bot), messages: bot.messages.map(storedMessage), workspace: bot.workspace })),
    conversations: [...conversations].map(([key, page]) => [key, { ...page, messages: page.messages.map(storedMessage) }]),
  };
}

/** A session owns its writes; logout waits for them before deleting that account's data. */
export class AccountCache {
  private writes: Promise<void> = Promise.resolve();
  private closed = false;
  private knownFiles = new Set<string>();
  private previousState: string | undefined;
  constructor(private storage: OfflineStorage, readonly account: string, private failed: () => void) {}
  async restore(): Promise<OfflineSnapshot | null> {
    const value = await this.storage.readState(this.account);
    if (this.closed || !value) return null;
    try {
      const snapshot = snapshotSchema.parse(JSON.parse(value));
      this.previousState = value;
      return snapshot;
    } catch { this.failed(); return null; }
  }
  private write(operation: () => Promise<void>): Promise<void> {
    if (this.closed) return Promise.resolve();
    const flight = this.writes.then(operation).catch(() => { if (!this.closed) this.failed(); });
    this.writes = flight;
    return flight;
  }
  save(snapshot: OfflineSnapshot): Promise<void> {
    const value = JSON.stringify(snapshot);
    if (value === this.previousState) return this.writes;
    return this.write(async () => { await this.storage.writeState(this.account, value); this.previousState = value; });
  }
  async hasFile(key: string): Promise<boolean> {
    if (this.closed) return false;
    if (this.knownFiles.has(key)) return true;
    const exists = await this.storage.hasFile(this.account, key);
    if (exists && !this.closed) this.knownFiles.add(key);
    return exists;
  }
  async file(key: string): Promise<BinaryFile | null> {
    if (this.closed) return null;
    const file = await this.storage.readFile(this.account, key);
    if (this.closed) return null;
    if (file) this.knownFiles.add(key); else this.knownFiles.delete(key);
    return file;
  }
  putFile(key: string, file: BinaryFile): Promise<void> {
    return this.write(async () => { await this.storage.writeFile(this.account, key, file); this.knownFiles.add(key); });
  }
  async close(remove = false): Promise<void> {
    this.closed = true;
    await this.writes;
    if (remove) await this.storage.clear(this.account);
  }
}
