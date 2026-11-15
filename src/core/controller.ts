import { z } from "zod";
import { automationKey, automationPath, automationSchema, connectedAppsSchema, readAutomations, type Automation, type ConnectedApp } from "./automations";
import { fileName, messageFiles, remoteReference } from "./media";
import { AccountCache, cachedFileKey, mergeMessagePage, offlineSnapshot } from "./offline";
import { MAX_FILE_BYTES } from "./relay";
import { MobileApi } from "./api";
import { RelayConnection, pinConnection } from "./relay";
import { botKey, botSchema, directorySchema, errorMessage, messagePageSchema, type Bot, type Message, type NotificationRoute, type Platform, type Session, type Workspace, type WorkspaceConnection, type BinaryFile, type DraftImage } from "./contracts";

export interface State {
  phase: "boot" | "login" | "ready";
  session: Session | null; bots: Bot[]; workspaces: Workspace[]; sections: Record<string, string[]>;
  selected: string | null; selectedThread: string | null; messages: Message[]; hasMore: boolean;
  loading: boolean; loadingMessages: boolean; sending: boolean;
  error: string; chatError: string; sourceErrors: Record<string, string>;
  challenge: string | null; push: "off" | "on" | "busy" | "unavailable";
  pushError: string; images: Record<string, DraftImage[]>; picking: boolean; drafts: Record<string, string>;
  offline: boolean; cacheError: string; cachePending: number;
  automations: Record<string, Automation[]>; apps: Record<string, ConnectedApp[]>;
  workspaceLoading: Record<string, boolean>; workspaceErrors: Record<string, string>; automationBusy: string[];
}
const initial = (): State => ({ phase: "boot", session: null, bots: [], workspaces: [], sections: {}, selected: null, selectedThread: null, messages: [], hasMore: false, loading: false, loadingMessages: false, sending: false, error: "", chatError: "", sourceErrors: {}, challenge: null, push: "off", pushError: "", images: {}, picking: false, drafts: {}, offline: false, cacheError: "", cachePending: 0, automations: {}, apps: {}, workspaceLoading: {}, workspaceErrors: {}, automationBusy: [] });
const conversationKey = (bot: Bot) => `${botKey(bot)}/${bot.threadId}`;

export class MobileController {
  private state: State = initial();
  private listeners = new Set<() => void>();
  private epoch = 0;
  private historyEpoch = 0;
  private connections = new Map<string, Promise<WorkspaceConnection>>();
  private cachedMessages = new Map<string, { messages: Message[]; hasMore: boolean }>();
  private sends = new Map<string, { text: string; sendId: string; fingerprint: string }>();
  private transfers = new Set<AbortController>();
  private activeSends = new Set<string>();
  private refreshFlight: Promise<void> | undefined;
  private historyFlight: Promise<void> | undefined;
  private pushFlight: Promise<void> | undefined;
  private route: NotificationRoute | null = null;
  private booted = false;
  private cleanup: Array<() => void> = [];
  private visible = true;
  private presenceAt = 0;
  private cache: AccountCache | null = null;
  private fileFlights = new Map<string, Promise<BinaryFile>>();
  private fileQueue = new Map<string, { bot: Bot; messageId: string | null; path: string }>();
  private fileAttempts = new Map<string, number>();
  private failedFiles = new Set<string>();
  private preloading = new Set<Promise<void>>();
  private workspaceFlights = new Map<string, Promise<void>>();
  private workspaceVersions = new Map<string, number>();
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  readonly snapshot = () => this.state;
  constructor(readonly api: MobileApi, readonly platform: Platform, private connect: (descriptor: Awaited<ReturnType<MobileApi["connection"]>>) => Promise<WorkspaceConnection> = RelayConnection.connect) {}
  private update(patch: Partial<State>): void { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()); }
  private cacheFailure = (): void => { this.update({ cacheError: "部分内容未能保存到手机，请检查可用存储空间后重新同步。" }); };
  private async restoreCache(session: Session): Promise<void> {
    const epoch = this.epoch;
    this.cache = new AccountCache(this.platform.cache, session.account.id, () => { if (epoch === this.epoch) this.cacheFailure(); });
    try {
      const saved = await this.cache.restore();
      if (!saved || epoch !== this.epoch) return;
      this.cachedMessages = new Map(saved.conversations);
      const workspaces = saved.workspaces.map(workspace => ({ ...workspace, online: false }));
      this.update({ workspaces, sections: saved.sections, bots: saved.bots.map(bot => ({ ...bot, busy: false, workspace: { ...bot.workspace, online: false } })) });
    } catch { if (epoch === this.epoch) this.cacheFailure(); }
  }
  private persistCache(): Promise<void> {
    return this.cache?.save(offlineSnapshot(this.state.workspaces, this.state.bots, this.cachedMessages, this.state.sections)) ?? Promise.resolve();
  }
  async retryCache(): Promise<void> {
    this.fileAttempts.clear(); this.failedFiles.clear();
    this.update({ cacheError: "" });
    await this.persistCache();
    this.cacheAttachments();
  }
  private queueFiles(bot: Bot, messageId: string | null, path: string): void {
    if (!this.cache || this.state.offline) return;
    const key = cachedFileKey(bot, messageId, path);
    if (this.fileQueue.has(key) || Date.now() - (this.fileAttempts.get(key) ?? 0) < 60_000) return;
    this.fileAttempts.set(key, Date.now());
    this.fileQueue.set(key, { bot, messageId, path });
  }
  private cacheAttachments(): void {
    for (const bot of this.state.bots) if (bot.avatarUrl) this.queueFiles(bot, null, bot.avatarUrl);
    for (const [key, page] of this.cachedMessages) {
      const [workspaceId, botId, threadId] = key.split("/");
      const bot = this.state.bots.find(bot => bot.workspace.id === workspaceId && bot.id === botId);
      if (!bot) continue;
      for (const message of page.messages) for (const attachment of messageFiles(message)) this.queueFiles({ ...bot, threadId }, message.id, attachment.path);
    }
    this.drainFiles();
  }
  private drainFiles(): void {
    if (!this.cache || !this.state.session || this.state.offline) return;
    const epoch = this.epoch, cache = this.cache;
    while (this.preloading.size < 2 && this.fileQueue.size) {
      const [key, file] = this.fileQueue.entries().next().value!;
      this.fileQueue.delete(key);
      const task = (async () => {
        try {
          if (!await cache.hasFile(key) && epoch === this.epoch) await this.file(file.bot, file.messageId, file.path);
          if (epoch === this.epoch) this.failedFiles.delete(key);
        } catch { if (epoch === this.epoch) { this.failedFiles.add(key); this.update({ cacheError: "部分附件尚未缓存，保持联网后将自动重试。" }); } }
      })();
      this.preloading.add(task);
      void task.finally(() => {
        this.preloading.delete(task);
        if (epoch === this.epoch) this.update({ cachePending: this.fileQueue.size + this.preloading.size, ...(!this.failedFiles.size && this.state.cacheError === "部分附件尚未缓存，保持联网后将自动重试。" ? { cacheError: "" } : {}) });
        this.drainFiles();
      });
    }
    this.update({ cachePending: this.fileQueue.size + this.preloading.size });
  }
  selectedBot(): Bot | undefined {
    const bot = this.state.bots.find(bot => botKey(bot) === this.state.selected);
    return bot ? { ...bot, threadId: this.state.selectedThread ?? bot.threadId } : undefined;
  }

  loadWorkspaceData(workspaceId: string, kind: "automations" | "apps"): Promise<void> {
    const key = `${kind}/${workspaceId}`, previous = this.workspaceFlights.get(key);
    if (previous) return previous;
    const workspace = this.state.workspaces.find(item => item.id === workspaceId);
    if (!workspace || !this.state.session) return Promise.resolve();
    if (this.state.offline || !workspace.online || this.state.sourceErrors[workspaceId]) {
      this.update({ workspaceErrors: { ...this.state.workspaceErrors, [key]: "设备离线，连接后即可同步和管理。" } });
      return Promise.resolve();
    }
    const epoch = this.epoch, version = this.workspaceVersions.get(key);
    this.update({ workspaceLoading: { ...this.state.workspaceLoading, [key]: true }, workspaceErrors: { ...this.state.workspaceErrors, [key]: "" } });
    let flight: Promise<void>;
    flight = (async () => {
      try {
        const connection = await this.connection(workspace);
        if (kind === "automations") {
          const items = await readAutomations(connection);
          if (epoch === this.epoch && version === this.workspaceVersions.get(key)) this.update({ automations: { ...this.state.automations, [workspaceId]: items } });
        } else {
          const reply = connectedAppsSchema.parse(await connection.request("/api/connectors/connected"));
          if (reply.credentialStore === "unavailable" || reply.inventoryComplete === false) throw new Error("暂时无法完整读取应用连接，请稍后重试。");
          if (epoch === this.epoch) this.update({ apps: { ...this.state.apps, [workspaceId]: Object.entries(reply.services).map(([id, app]) => ({ ...app, id })) } });
        }
      } catch (error) { if (epoch === this.epoch) this.update({ workspaceErrors: { ...this.state.workspaceErrors, [key]: errorMessage(error) } }); }
      finally {
        if (epoch === this.epoch) this.update({ workspaceLoading: { ...this.state.workspaceLoading, [key]: false } });
      }
    })();
    this.workspaceFlights.set(key, flight);
    void flight.finally(() => { if (this.workspaceFlights.get(key) === flight) this.workspaceFlights.delete(key); });
    return flight;
  }

  async setAutomationEnabled(workspaceId: string, item: Automation, enabled: boolean): Promise<void> {
    const workspace = this.state.workspaces.find(workspace => workspace.id === workspaceId);
    const key = automationKey(workspaceId, item), source = `automations/${workspaceId}`;
    const current = this.state.automations[workspaceId]?.find(candidate => automationKey(workspaceId, candidate) === key);
    if (!workspace || !current || !this.state.session || this.state.automationBusy.includes(key)) return;
    if (this.state.offline || !workspace.online || this.state.sourceErrors[workspaceId]) {
      this.update({ workspaceErrors: { ...this.state.workspaceErrors, [source]: "设备离线，连接后才能更改自动化工作。" } });
      return;
    }
    const epoch = this.epoch;
    this.workspaceVersions.set(source, (this.workspaceVersions.get(source) ?? 0) + 1);
    this.update({ automationBusy: [...this.state.automationBusy, key], workspaceErrors: { ...this.state.workspaceErrors, [source]: "" } });
    try {
      const path = `/api/${automationPath(item.kind)}/${item.id}${item.kind === "schedule" ? "" : "/enabled"}`;
      const reply = await (await this.connection(workspace)).request<Record<string, unknown>>(path, { method: item.kind === "schedule" ? "PATCH" : "POST", body: { enabled } });
      const value = automationSchema.parse(reply[item.kind === "schedule" ? "routine" : item.kind === "webhook" ? "webhook" : "trigger"]);
      if (value.id !== item.id) throw new Error("自动化工作未能更新，请刷新后重试。");
      if (epoch === this.epoch) this.update({ automations: { ...this.state.automations, [workspaceId]: this.state.automations[workspaceId].map(candidate => automationKey(workspaceId, candidate) === key ? { ...value, kind: item.kind } : candidate) } });
    } catch (error) { if (epoch === this.epoch) this.update({ workspaceErrors: { ...this.state.workspaceErrors, [source]: errorMessage(error) } }); }
    finally {
      if (epoch === this.epoch) {
        this.workspaceVersions.set(source, (this.workspaceVersions.get(source) ?? 0) + 1);
        this.update({ automationBusy: this.state.automationBusy.filter(busy => busy !== key) });
      }
    }
  }

  async boot(): Promise<void> {
    if (this.booted) return;
    this.booted = true;
    await this.platform.media.clear();
    const opened = this.platform.push.onOpen(route => {
      this.route = route;
      if (this.state.session) void this.refresh().then(() => this.openNotification());
    });
    const received = this.platform.push.onReceive(() => { if (this.state.session) void this.refresh().then(() => this.pollMessages()); });
    const resumed = this.platform.onResume(() => { this.fileAttempts.clear(); if (this.state.session) void this.refresh().then(() => this.pollMessages()); });
    const installed = await Promise.allSettled([opened, received, resumed]);
    for (const result of installed) if (result.status === "fulfilled") this.cleanup.push(result.value);
    const onVisibility = () => { this.visible = !document.hidden; if (this.visible && this.state.session) { this.fileAttempts.clear(); void this.refresh().then(() => this.pollMessages()); } };
    document.addEventListener("visibilitychange", onVisibility);
    this.cleanup.push(() => document.removeEventListener("visibilitychange", onVisibility));
    if (typeof window !== "undefined") {
      const offline = () => {
        this.update({ offline: true, bots: this.state.bots.map(bot => ({ ...bot, busy: false, workspace: { ...bot.workspace, online: false } })), workspaces: this.state.workspaces.map(workspace => ({ ...workspace, online: false })) });
        for (const id of this.connections.keys()) this.evict(id);
      };
      const online = () => { this.fileAttempts.clear(); if (this.state.session) void this.refresh().then(() => this.pollMessages()); };
      window.addEventListener("offline", offline); window.addEventListener("online", online);
      this.cleanup.push(() => { window.removeEventListener("offline", offline); window.removeEventListener("online", online); });
    }
    const polling = setInterval(() => { if (this.visible && this.state.session) void this.refresh().then(() => this.pollMessages()); }, 4000);
    this.cleanup.push(() => clearInterval(polling));
    try {
      const session = await this.api.restore();
      if (session) await this.restoreCache(session);
      this.update({ phase: session ? "ready" : "login", session, push: this.platform.kind === "web" ? "unavailable" : "off" });
      if (session) { await this.refresh(); this.openNotification(); void this.restorePush(); }
    } catch { this.update({ phase: "login", error: "无法读取登录状态，请重新登录。" }); }
  }
  async login(email: string, password: string): Promise<void> {
    if (this.state.loading) return;
    this.update({ loading: true, error: "" });
    try {
      const result = await this.api.login(email.trim(), password);
      if ("challenge" in result) this.update({ challenge: result.challenge });
      else await this.signedIn(result.session);
    } catch (error) { this.update({ error: errorMessage(error) }); }
    finally { this.update({ loading: false }); }
  }
  async verify(code: string): Promise<void> {
    if (!this.state.challenge || this.state.loading) return;
    this.update({ loading: true, error: "" });
    try { await this.signedIn(await this.api.verify(this.state.challenge, code)); }
    catch (error) { this.update({ error: errorMessage(error) }); }
    finally { this.update({ loading: false }); }
  }
  cancelChallenge(): void { this.update({ challenge: null, error: "" }); }
  private async signedIn(session: Session): Promise<void> {
    const oldCache = this.cache; this.cache = null;
    ++this.epoch;
    this.clearMedia();
    for (const id of this.connections.keys()) this.evict(id);
    this.cachedMessages.clear(); this.sends.clear(); this.activeSends.clear();
    this.refreshFlight = undefined; this.historyFlight = undefined;
    this.workspaceFlights.clear(); this.workspaceVersions.clear();
    this.state = { ...initial(), loading: this.state.loading, push: this.platform.kind === "web" ? "unavailable" : "off" };
    this.presenceAt = 0;
    this.update({ phase: "boot" });
    await oldCache?.close();
    await this.restoreCache(session);
    this.update({ session, phase: "ready", challenge: null, error: "" });
    await this.refresh(); this.openNotification(); void this.restorePush();
  }
  private async connection(workspace: Workspace): Promise<WorkspaceConnection> {
    const epoch = this.epoch;
    let existing = this.connections.get(workspace.id);
    if (!existing) {
      existing = (async () => {
        const descriptor = await this.api.connection(workspace.id);
        if (epoch !== this.epoch || !this.state.session) throw new Error("账号已切换。");
        await pinConnection(this.platform.vault, this.state.session.account.id, workspace.id, descriptor);
        if (epoch !== this.epoch) throw new Error("账号已切换。");
        const connection = await this.connect(descriptor);
        if (epoch !== this.epoch) { connection.close(); throw new Error("账号已切换。"); }
        return connection;
      })();
      this.connections.set(workspace.id, existing);
    }
    try { return await existing; }
    catch (error) { if (this.connections.get(workspace.id) === existing) this.connections.delete(workspace.id); throw error; }
  }
  private evict(id: string): void {
    const existing = this.connections.get(id);
    this.connections.delete(id); void existing?.then(connection => connection.close(), () => {});
  }
  refresh(): Promise<void> {
    if (this.refreshFlight) return this.refreshFlight;
    if (!this.state.session) return Promise.resolve();
    const epoch = this.epoch;
    const flight = (async () => {
      try {
        if (typeof navigator !== "undefined" && navigator.onLine === false) throw new Error("当前离线，可查看已缓存的消息和附件。");
        if (Date.now() - this.presenceAt >= 15_000) {
          await this.api.presence(this.platform.kind);
          if (epoch !== this.epoch) return;
          this.presenceAt = Date.now();
        }
        const workspaces = await this.api.workspaces();
        if (epoch !== this.epoch) return;
        for (const [id] of this.connections) if (!workspaces.some(workspace => workspace.id === id && workspace.online)) this.evict(id);
        const sections = { ...this.state.sections };
        const results = await Promise.allSettled(workspaces.map(async workspace => {
          if (!workspace.online) return this.state.bots.filter(bot => bot.workspace.id === workspace.id).map(bot => ({ ...bot, workspace }));
          try {
            const reply = directorySchema.parse(await (await this.connection(workspace)).request("/api/bots?messages=20"));
            sections[workspace.id] = reply.sections;
            return [...reply.bots, ...reply.groups.map(group => botSchema.parse({ ...group, conversationKind: "group", busy: group.working }))].map(bot => ({ ...bot, workspace }));
          } catch (error) { if (epoch === this.epoch) this.evict(workspace.id); throw error; }
        }));
        if (epoch !== this.epoch) return;
        const bots: Bot[] = []; const sourceErrors: Record<string, string> = {};
        results.forEach((result, index) => {
          const workspace = workspaces[index];
          if (result.status === "fulfilled") bots.push(...result.value);
          else {
            sourceErrors[workspace.id] = errorMessage(result.reason);
            bots.push(...this.state.bots.filter(bot => bot.workspace.id === workspace.id).map(bot => ({ ...bot, workspace: { ...workspace, online: false } })));
          }
        });
        const merged = bots.map(bot => {
          const unread = this.state.selected === botKey(bot) && this.state.selectedThread === bot.threadId && this.visible ? false : bot.unread;
          return { ...bot, unread };
        });
        const lostSelection = this.state.selected && !merged.some(bot => botKey(bot) === this.state.selected);
        if (lostSelection) { ++this.historyEpoch; this.historyFlight = undefined; }
        for (const key of this.cachedMessages.keys()) if (!merged.some(bot => key.startsWith(`${botKey(bot)}/`))) this.cachedMessages.delete(key);
        for (const bot of merged) if (bot.messages.length) {
          const key = conversationKey(bot);
          this.cachedMessages.set(key, mergeMessagePage(this.cachedMessages.get(key), { messages: bot.messages, hasMore: true }));
        }
        this.update({ workspaces, sections: Object.fromEntries(workspaces.map(workspace => [workspace.id, sections[workspace.id] ?? []])), bots: merged, sourceErrors, error: "", offline: false, ...(lostSelection ? { selected: null, selectedThread: null, messages: [], hasMore: false, sending: false, loadingMessages: false, chatError: "" } : {}) });
        await this.persistCache();
        if (epoch === this.epoch) this.cacheAttachments();
      } catch (error) {
        if (epoch === this.epoch) {
          this.update({ offline: true, error: errorMessage(error), bots: this.state.bots.map(bot => ({ ...bot, busy: false, workspace: { ...bot.workspace, online: false } })), workspaces: this.state.workspaces.map(workspace => ({ ...workspace, online: false })) });
          for (const id of this.connections.keys()) this.evict(id);
        }
      }
    })();
    this.refreshFlight = flight;
    void flight.finally(() => { if (this.refreshFlight === flight) this.refreshFlight = undefined; });
    return flight;
  }
  async select(bot: Bot, threadId = bot.threadId): Promise<void> {
    ++this.historyEpoch;
    this.historyFlight = undefined;
    const key = botKey(bot), conversation = conversationKey({ ...bot, threadId });
    const cached = this.cachedMessages.get(conversation);
    this.update({ selected: key, selectedThread: threadId, messages: cached?.messages ?? [], hasMore: cached?.hasMore ?? false, sending: this.activeSends.has(conversation), chatError: "", bots: this.state.bots.map(item => botKey(item) === key ? { ...item, unread: false } : item) });
    await this.loadMessages(false);
  }
  back(): void { ++this.historyEpoch; this.historyFlight = undefined; this.update({ selected: null, selectedThread: null, messages: [], chatError: "", sending: false, loadingMessages: false }); }
  setDraft(value: string): void {
    const bot = this.selectedBot(), key = bot ? conversationKey(bot) : null;
    if (key) this.update({ drafts: { ...this.state.drafts, [key]: value } });
  }
  pollMessages(): Promise<void> { return this.state.selected ? this.loadMessages(false, true) : Promise.resolve(); }
  loadMessages(older = false, quiet = false): Promise<void> {
    if (this.historyFlight) return this.historyFlight;
    const bot = this.selectedBot();
    if (!bot) return Promise.resolve();
    if (this.state.offline || !bot.workspace.online) {
      this.update({ loadingMessages: false, chatError: this.state.messages.length ? "离线模式，正在显示已缓存的消息。" : "此会话尚未同步，连接设备后即可查看。" });
      return Promise.resolve();
    }
    const epoch = this.epoch, historyEpoch = this.historyEpoch, key = conversationKey(bot);
    if (!quiet) this.update({ loadingMessages: true, chatError: "" });
    const flight = (async () => {
      try {
        const before = older ? this.state.messages[0]?.id : undefined;
        const path = `/api/threads/${bot.threadId}/messages?limit=50${before ? `&before=${encodeURIComponent(before)}` : ""}`;
        const page = messagePageSchema.parse(await (await this.connection(bot.workspace)).request(path));
        if (epoch !== this.epoch || historyEpoch !== this.historyEpoch) return;
        const merged = mergeMessagePage(this.cachedMessages.get(key), page, older);
        this.cachedMessages.set(key, merged);
        this.update({ messages: merged.messages, hasMore: merged.hasMore, chatError: "" });
        await this.persistCache();
        if (epoch !== this.epoch) return;
        this.cacheAttachments();
        if (this.visible) void (await this.connection(bot.workspace)).request(`/api/${bot.conversationKind === "group" ? "groups" : "bots"}/${bot.id}/read`, { method: "POST", body: { threadId: bot.threadId } }).catch(() => {});
      } catch (error) {
        if (epoch === this.epoch) this.evict(bot.workspace.id);
        if (epoch === this.epoch && historyEpoch === this.historyEpoch) this.update({ chatError: errorMessage(error) });
      } finally { if (epoch === this.epoch && historyEpoch === this.historyEpoch) this.update({ loadingMessages: false }); }
    })();
    this.historyFlight = flight;
    void flight.finally(() => { if (this.historyFlight === flight) this.historyFlight = undefined; });
    return flight;
  }
  async send(): Promise<void> {
    const bot = this.selectedBot(); if (!bot || !this.state.session || this.activeSends.has(conversationKey(bot))) return;
    if (this.state.offline || !bot.workspace.online) { this.update({ chatError: "当前离线，连接设备后即可发送。" }); return; }
    const key = conversationKey(bot), value = this.state.drafts[key]?.trim() ?? "";
    const images = [...(this.state.images[key] ?? [])];
    if (!value && !images.length) return;
    const fingerprint = JSON.stringify([value, images.map(image => image.id)]);
    const previous = this.sends.get(key);
    let send = previous?.fingerprint === fingerprint ? previous : undefined;
    this.activeSends.add(key);
    const epoch = this.epoch, historyEpoch = this.historyEpoch;
    this.update({ sending: true, chatError: "" });
    try {
      for (const image of images) {
        if (image.path) continue;
        const reply = z.object({ path: z.string().min(1), mime: z.string(), bytes: z.number() }).parse(await (await this.connection(bot.workspace)).request(`/api/attachments?uploadId=${image.id}`, { method: "POST", rawBody: new Uint8Array(await image.blob.arrayBuffer()), contentType: image.blob.type }));
        if (epoch !== this.epoch) return;
        image.path = reply.path;
      }
      if (!send) {
        const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const text = [value, ...images.map(image => `<attached-image path="${escape(image.path!)}" name="${escape(image.name)}" />`)].filter(Boolean).join("\n\n");
        send = { text, sendId: crypto.randomUUID(), fingerprint };
        this.sends.set(key, send);
      }
      await (await this.connection(bot.workspace)).request(`/api/${bot.conversationKind === "group" ? "groups" : "bots"}/${bot.id}/messages`, { method: "POST", body: { text: send.text, sendId: send.sendId, threadId: bot.threadId } });
      if (epoch !== this.epoch) return;
      this.sends.delete(key);
      images.forEach(image => URL.revokeObjectURL(image.url));
      this.update({ images: { ...this.state.images, [key]: (this.state.images[key] ?? []).filter(image => !images.some(sent => sent.id === image.id)) } });
      if (this.state.drafts[key]?.trim() === value) this.update({ drafts: { ...this.state.drafts, [key]: "" } });
      if (historyEpoch === this.historyEpoch) await this.loadMessages(false);
      await this.refresh();
    } catch (error) {
      if (epoch === this.epoch) this.evict(bot.workspace.id);
      if (epoch === this.epoch && historyEpoch === this.historyEpoch) this.update({ chatError: `${errorMessage(error)} 消息可能已送达，再次发送会沿用同一请求标识。` });
    } finally {
      if (epoch === this.epoch) {
        this.activeSends.delete(key);
        const selected = this.selectedBot();
        if (selected && conversationKey(selected) === key) this.update({ sending: false });
      }
    }
  }
  async pickImages(source: "camera" | "library"): Promise<void> {
    const bot = this.selectedBot();
    if (!bot || this.state.picking || this.activeSends.has(conversationKey(bot))) return;
    const epoch = this.epoch, key = conversationKey(bot);
    this.update({ picking: true, chatError: "" });
    try {
      const picked = await this.platform.media.pickImages(source);
      if (epoch !== this.epoch) return;
      if ((this.state.images[key]?.length ?? 0) + picked.length > 8) throw new Error("每条消息最多添加 8 张图片。");
      if (picked.some(image => image.blob.size > 10 * 1024 * 1024 || !image.blob.size)) throw new Error("每张图片需小于 10 MB，且不能为空。");
      if (picked.some(image => !/^image\/(jpeg|png|gif|webp)$/.test(image.blob.type))) throw new Error("请选择 JPEG、PNG、GIF 或 WebP 图片。");
      const images = picked.map(image => ({ ...image, id: crypto.randomUUID(), url: URL.createObjectURL(image.blob) }));
      this.update({ images: { ...this.state.images, [key]: [...(this.state.images[key] ?? []), ...images] } });
    } catch (error) { if (epoch === this.epoch && this.selectedBot() && conversationKey(this.selectedBot()!) === key) this.update({ chatError: errorMessage(error) }); }
    finally { if (epoch === this.epoch) this.update({ picking: false }); }
  }
  removeImage(id: string): void {
    const bot = this.selectedBot(); if (!bot) return;
    const key = conversationKey(bot); if (this.activeSends.has(key)) return;
    const images = this.state.images[key] ?? [];
    images.filter(image => image.id === id).forEach(image => URL.revokeObjectURL(image.url));
    this.update({ images: { ...this.state.images, [key]: images.filter(image => image.id !== id) } });
  }
  async file(bot: Bot, messageId: string | null, path: string, signal?: AbortSignal): Promise<BinaryFile> {
    signal?.throwIfAborted();
    if (!this.state.session) throw new Error("请先登录。");
    const key = cachedFileKey(bot, messageId, path), epoch = this.epoch, cache = this.cache;
    let flight = this.fileFlights.get(key);
    if (!flight) {
      flight = (async () => {
        let saved: BinaryFile | null = null;
        try { saved = await cache?.file(key) ?? null; } catch { if (epoch === this.epoch) this.cacheFailure(); }
        if (epoch !== this.epoch) throw new Error("账号已切换。");
        if (saved) return saved;
        if (this.state.offline || (!bot.workspace.online && !remoteReference(path))) throw new Error("此附件尚未缓存，联网并连接设备后会自动下载。");
        const file = await this.downloadFile(bot, messageId, path);
        if (epoch !== this.epoch) throw new Error("账号已切换。");
        await cache?.putFile(key, file);
        if (epoch !== this.epoch) throw new Error("账号已切换。");
        return file;
      })();
      this.fileFlights.set(key, flight);
      const current = flight;
      void flight.finally(() => { if (this.fileFlights.get(key) === current) this.fileFlights.delete(key); }).catch(() => {});
    }
    if (!signal) return flight;
    return new Promise((resolve, reject) => {
      const aborted = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      signal.addEventListener("abort", aborted, { once: true });
      flight!.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
      if (signal.aborted) aborted();
    });
  }
  private async downloadFile(bot: Bot, messageId: string | null, path: string): Promise<BinaryFile> {
    const epoch = this.epoch;
    const transfer = new AbortController(); this.transfers.add(transfer);
    try {
      const combined = transfer.signal;
      combined.throwIfAborted();
      if (remoteReference(path)) {
        const response = await fetch(path, { credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.any([combined, AbortSignal.timeout(180_000)]) });
        if (!response.ok) throw new Error("无法读取外部文件，请稍后重试。");
        const chunks: Uint8Array[] = []; let size = 0;
        const reader = response.body?.getReader();
        if (Number(response.headers.get("content-length")) > MAX_FILE_BYTES) { await response.body?.cancel(); throw new Error("文件超过手机端 100 MB 的读取上限。"); }
        if (reader) {
          try {
            while (true) {
              const { done, value } = await reader.read(); if (done) break;
              size += value.length;
              if (size > MAX_FILE_BYTES) throw new Error("文件超过手机端 100 MB 的读取上限。");
              chunks.push(value);
            }
          } finally { await reader.cancel().catch(() => {}); }
        } else {
          const data = new Uint8Array(await response.arrayBuffer());
          if (data.length > MAX_FILE_BYTES) throw new Error("文件超过手机端 100 MB 的读取上限。");
          chunks.push(data);
        }
        if (epoch !== this.epoch) throw new Error("账号已切换。");
        return { data: new Uint8Array(await new Blob(chunks as BlobPart[]).arrayBuffer()), mime: response.headers.get("content-type") || "application/octet-stream", name: fileName(path) };
      }
      const connection = await this.connection(bot.workspace);
      const reply = await connection.request<BinaryFile>(messageId ? `/api/threads/${bot.threadId}/messages/${messageId}/file` : path, { ...(messageId ? { method: "POST", body: { path } } : {}), responseType: "bytes", signal: combined });
      if (epoch !== this.epoch) throw new Error("账号已切换。");
      return reply;
    } finally { this.transfers.delete(transfer); }
  }
  private clearMedia(): void {
    this.transfers.forEach(transfer => transfer.abort()); this.transfers.clear();
    this.fileFlights.clear(); this.fileQueue.clear(); this.fileAttempts.clear(); this.failedFiles.clear();
    Object.values(this.state.images).flat().forEach(image => URL.revokeObjectURL(image.url));
    void this.platform.media.clear();
  }
  private openNotification(): void {
    const route = this.route;
    if (!route || route.accountId !== this.state.session?.account.id) { if (this.state.session) this.route = null; return; }
    const bot = this.state.bots.find(bot => bot.workspace.id === route.workspaceId && (bot.conversationKind === "group" || bot.id === route.botId) && (bot.threadId === route.threadId || bot.tasks.some(task => task.threadId === route.threadId)));
    if (bot) { this.route = null; void this.select(bot, route.threadId); }
  }
  private async restorePush(): Promise<void> {
    const accountId = this.state.session?.account.id;
    if (!accountId) return;
    try {
      const preference = await this.platform.vault.read(`donebot.push.${accountId}`);
      if (this.state.session?.account.id === accountId && preference === "on" && await this.platform.push.permission() === "granted") await this.enablePush();
    } catch { }
  }
  enablePush(): Promise<void> {
    if (this.pushFlight) return this.pushFlight;
    const accountId = this.state.session?.account.id;
    if (!accountId || this.platform.kind === "web") return Promise.resolve();
    const epoch = this.epoch;
    this.update({ push: "busy", pushError: "" });
    const flight = (async () => {
      try {
        const registration = await this.platform.push.register();
        if (epoch !== this.epoch || !this.state.session) return;
        await this.api.subscribe(registration);
        if (epoch === this.epoch) {
          await this.platform.vault.write(`donebot.push.${accountId}`, "on");
          if (epoch === this.epoch) this.update({ push: "on" });
        }
      } catch (error) { if (epoch === this.epoch) this.update({ push: "off", pushError: errorMessage(error) }); }
    })();
    this.pushFlight = flight;
    void flight.finally(() => { if (this.pushFlight === flight) this.pushFlight = undefined; });
    return flight;
  }
  async disablePush(): Promise<void> {
    const accountId = this.state.session?.account.id;
    if (!accountId || this.pushFlight) return;
    const epoch = this.epoch;
    this.update({ push: "busy", pushError: "" });
    const flight = (async () => {
      try {
        await this.api.unsubscribe();
        if (epoch !== this.epoch) return;
        await this.platform.vault.write(`donebot.push.${accountId}`, "off");
        await this.platform.push.unregister();
        if (epoch === this.epoch) this.update({ push: "off" });
      } catch (error) { if (epoch === this.epoch) this.update({ push: "on", pushError: errorMessage(error) }); }
    })();
    this.pushFlight = flight;
    await flight;
    if (this.pushFlight === flight) this.pushFlight = undefined;
  }
  async logout(): Promise<void> {
    if (this.state.loading) return;
    const cache = this.cache; this.cache = null;
    ++this.epoch; ++this.historyEpoch; this.clearMedia();
    this.state = initial(); this.update({ loading: true });
    this.refreshFlight = undefined; this.historyFlight = undefined;
    this.workspaceFlights.clear(); this.workspaceVersions.clear();
    for (const id of this.connections.keys()) this.evict(id);
    this.cachedMessages.clear(); this.sends.clear(); this.activeSends.clear(); this.route = null;
    const clearing = cache?.close(true).then(() => "", () => "登录已退出，但本机缓存未能完全清除，请检查手机存储后重试。") ?? Promise.resolve("");
    await this.pushFlight;
    if (this.platform.kind !== "web") {
      try { await this.api.unsubscribe(); } catch { }
      try { await this.platform.push.unregister(); } catch { }
    }
    const cacheError = await clearing;
    try { await this.api.logout(); }
    finally { this.state = initial(); this.update({ phase: "login", error: cacheError, push: this.platform.kind === "web" ? "unavailable" : "off" }); }
  }
  dispose(): void { ++this.epoch; this.clearMedia(); void this.cache?.close().catch(() => {}); this.cache = null; this.cleanup.forEach(dispose => dispose()); this.cleanup = []; for (const id of this.connections.keys()) this.evict(id); }
}
