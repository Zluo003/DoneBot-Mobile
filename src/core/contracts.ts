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

export const attachmentSchema = z.object({
  kind: z.enum(["image", "file", "audio"]), path: z.string().min(1), mime: z.string(),
  name: z.string().optional(), durationMs: z.number().optional(), text: z.string().optional(),
});
export type Attachment = z.infer<typeof attachmentSchema>;
export interface BinaryFile { data: Uint8Array; mime: string; name: string }
export interface PickedImage { name: string; blob: Blob }
export interface DraftImage extends PickedImage { id: string; url: string; path?: string }
export type FileAction = "open" | "save" | "share";
export interface MediaPlatform {
  pickImages(source: "camera" | "library"): Promise<PickedImage[]>;
  fileAction(file: Blob, name: string, action: FileAction): Promise<void>;
  clear(): Promise<void>;
}
export interface OfflineStorage {
  readState(account: string): Promise<string | null>;
  writeState(account: string, value: string): Promise<void>;
  hasFile(account: string, key: string): Promise<boolean>;
  readFile(account: string, key: string): Promise<BinaryFile | null>;
  writeFile(account: string, key: string, file: BinaryFile): Promise<void>;
  clear(account: string): Promise<void>;
}
export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH"; body?: unknown; signal?: AbortSignal;
  rawBody?: Uint8Array; contentType?: string; responseType?: "bytes";
}

export const messageSchema = z.object({
  id: idSchema, role: z.enum(["bot", "user"]), text: z.string().default(""),
  timestamp: z.union([z.string(), z.number()]).optional(), kind: z.string().default("text"),
  at: z.number().optional(),
  from: z.object({ botId: z.string(), name: z.string(), color: z.string().optional() }).optional(),
  sendId: z.string().optional(), attachments: z.array(attachmentSchema).optional(),
}).passthrough().transform(message => ({ ...message, timestamp: message.timestamp ?? message.at }));
export type Message = z.infer<typeof messageSchema>;
const defaultBotSchema = z.union([
  z.object({ person: z.string().optional() }),
  z.boolean().transform(value => value ? {} : undefined),
]);
export const botSchema = z.object({
  id: idSchema, name: z.string(), threadId: idSchema,
  conversationKind: z.enum(["bot", "group"]).optional(), memberIds: z.array(idSchema).optional(),
  section: z.string().optional(), chiefOfStaff: z.boolean().optional(), defaultBot: defaultBotSchema.optional(),
  title: z.string().optional(), emoji: z.string().optional(), color: z.string().optional(),
  avatarUrl: z.string().nullable().optional(), avatarCrop: z.enum(["mascot", "circle", "rounded", "square"]).optional(),
  avatarZoom: z.number().optional(), avatarFocusX: z.number().optional(), avatarFocusY: z.number().optional(),
  mascotBody: z.string().nullable().optional(), mascotFaceColor: z.enum(["white", "black"]).nullable().optional(), mascotExpression: z.number().nullable().optional(),
  busy: z.boolean().default(false), messages: z.array(messageSchema).default([]),
  unread: z.boolean().default(false),
  tasks: z.array(z.object({ threadId: idSchema })).default([]),
}).passthrough();
export type Bot = z.infer<typeof botSchema> & { workspace: Workspace };
export const directorySchema = z.object({
  bots: z.array(botSchema), sections: z.array(z.string()).default([]),
  groups: z.array(z.object({ id: idSchema, name: z.string(), threadId: idSchema, memberIds: z.array(idSchema), section: z.string().optional(), working: z.boolean().default(false), unread: z.boolean().default(false), messages: z.array(messageSchema).default([]), tasks: z.array(z.object({ threadId: idSchema })).default([]) })).default([]),
});
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
  media: MediaPlatform;
  cache: OfflineStorage;
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
  request<T>(path: string, options?: RequestOptions): Promise<T>;
  close(): void;
}

export const visibleWorkspaces = (workspaces: Workspace[]): Workspace[] => workspaces.filter(workspace => workspace.kind === "computer" || workspace.provisioned);
export const botKey = (bot: Pick<Bot, "workspace" | "id">): string => `${bot.workspace.id}/${bot.id}`;
export function errorMessage(error: unknown): string {
  if (error instanceof z.ZodError || error instanceof SyntaxError) return "收到的数据暂不兼容，请更新 App 后重试。";
  return error instanceof Error ? error.message : "暂时无法连接，请稍后重试。";
}
