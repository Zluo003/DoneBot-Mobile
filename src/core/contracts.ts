import { z } from "zod";

export const idSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/);
export const accountSchema = z.object({ id: z.union([z.string(), z.number()]).transform(String), email: z.email(), username: z.string().optional() });
export type Account = z.infer<typeof accountSchema>;
export const sessionSchema = z.object({
  accessToken: z.string().min(1), refreshToken: z.string().min(1).optional(),
  expiresAt: z.number().finite(), account: accountSchema,
});
export type Session = z.infer<typeof sessionSchema>;
export const workspaceSchema = z.object({
  id: idSchema, name: z.string().min(1).max(100), kind: z.enum(["computer", "cloud"]),
  online: z.boolean(), provisioned: z.boolean(),
});
export type Workspace = z.infer<typeof workspaceSchema>;
export const workspacesSchema = z.object({ workspaces: z.array(workspaceSchema).max(100) });
export const descriptorSchema = z.object({
  v: z.literal(1), k: z.string().max(100), h: z.string().max(40),
  r: z.array(z.string().max(255)).min(1).max(4), deviceToken: z.string().min(16).max(2048),
});
export type ConnectionDescriptor = z.infer<typeof descriptorSchema>;

export const messageSchema = z.object({
  id: idSchema, role: z.enum(["bot", "user"]), text: z.string().default(""),
  timestamp: z.union([z.string(), z.number()]).optional(), kind: z.string().default("text"),
  at: z.number().optional(),
  sendId: z.string().optional(),
}).passthrough().transform(message => ({ ...message, timestamp: message.timestamp ?? message.at }));
export type Message = z.infer<typeof messageSchema>;
export const botSchema = z.object({
  id: idSchema, name: z.string(), threadId: idSchema,
  title: z.string().optional(), emoji: z.string().optional(), color: z.string().optional(),
  busy: z.boolean().default(false), messages: z.array(messageSchema).default([]),
  unread: z.boolean().default(false),
  tasks: z.array(z.object({ threadId: idSchema })).default([]),
}).passthrough();
export type Bot = z.infer<typeof botSchema> & { workspace: Workspace };
export const messagePageSchema = z.object({ messages: z.array(messageSchema), hasMore: z.boolean().default(false) });
export type MessagePage = z.infer<typeof messagePageSchema>;
export const notificationRouteSchema = z.object({
  accountId: idSchema, workspaceId: idSchema, botId: idSchema, threadId: idSchema,
  messageId: idSchema.optional(),
});
export type NotificationRoute = z.infer<typeof notificationRouteSchema>;
export type PushPermission = "prompt" | "granted" | "denied" | "unavailable";
export type PushRegistration = { token: string; platform: "ios" | "android" | "harmony"; environment: "sandbox" | "production" };
export interface SecureVault { read(key: string): Promise<string | null>; write(key: string, value: string): Promise<void>; remove(key: string): Promise<void> }
export interface Platform {
  kind: "ios" | "android" | "harmony" | "web";
  vault: SecureVault;
  push: {
    permission(): Promise<PushPermission>;
    register(): Promise<PushRegistration>;
    unregister(): Promise<void>;
    onOpen(listener: (route: NotificationRoute) => void): Promise<() => void>;
    onReceive(listener: () => void): Promise<() => void>;
  };
  onResume(listener: () => void): Promise<() => void>;
}
export interface WorkspaceConnection {
  request<T>(path: string, options?: { method?: "GET" | "POST"; body?: unknown; signal?: AbortSignal }): Promise<T>;
  close(): void;
}

export const visibleWorkspaces = (workspaces: Workspace[]): Workspace[] => workspaces.filter(workspace => workspace.kind === "computer" || workspace.provisioned);
export const botKey = (bot: Pick<Bot, "workspace" | "id">): string => `${bot.workspace.id}/${bot.id}`;
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "暂时无法连接，请稍后重试。"; }
