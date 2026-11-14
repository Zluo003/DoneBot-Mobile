import { z } from "zod";
import { MobileApi } from "./api";
import { RelayConnection, pinConnection } from "./relay";
import { botKey, botSchema, errorMessage, messagePageSchema, type Bot, type Message, type NotificationRoute, type Platform, type Session, type Workspace, type WorkspaceConnection } from "./contracts";

export interface State {
  phase: "boot" | "login" | "ready";
  session: Session | null; bots: Bot[]; workspaces: Workspace[];
  selected: string | null; selectedThread: string | null; messages: Message[]; hasMore: boolean;
  loading: boolean; loadingMessages: boolean; sending: boolean;
  error: string; chatError: string; sourceErrors: Record<string, string>;
  challenge: string | null; push: "off" | "on" | "busy" | "unavailable";
  pushError: string; drafts: Record<string, string>;
}
const initial = (): State => ({ phase: "boot", session: null, bots: [], workspaces: [], selected: null, selectedThread: null, messages: [], hasMore: false, loading: false, loadingMessages: false, sending: false, error: "", chatError: "", sourceErrors: {}, challenge: null, push: "off", pushError: "", drafts: {} });
const conversationKey = (bot: Bot) => `${botKey(bot)}/${bot.threadId}`;

export class MobileController {
  private state: State = initial();
  private listeners = new Set<() => void>();
  private epoch = 0;
  private historyEpoch = 0;
  private connections = new Map<string, Promise<WorkspaceConnection>>();
  private cachedMessages = new Map<string, { messages: Message[]; hasMore: boolean }>();
  private sends = new Map<string, { text: string; sendId: string }>();
  private activeSends = new Set<string>();
  private refreshFlight: Promise<void> | undefined;
  private historyFlight: Promise<void> | undefined;
  private pushFlight: Promise<void> | undefined;
  private route: NotificationRoute | null = null;
  private booted = false;
  private cleanup: Array<() => void> = [];
  private visible = true;
  private presenceAt = 0;
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  readonly snapshot = () => this.state;
  constructor(readonly api: MobileApi, readonly platform: Platform, private connect: (descriptor: Awaited<ReturnType<MobileApi["connection"]>>) => Promise<WorkspaceConnection> = RelayConnection.connect) {}
  private update(patch: Partial<State>): void { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()); }
  selectedBot(): Bot | undefined {
    const bot = this.state.bots.find(bot => botKey(bot) === this.state.selected);
    return bot ? { ...bot, threadId: this.state.selectedThread ?? bot.threadId } : undefined;
  }

  async boot(): Promise<void> {
    if (this.booted) return;
    this.booted = true;
    const opened = this.platform.push.onOpen(route => {
      this.route = route;
      if (this.state.session) void this.refresh().then(() => this.openNotification());
    });
    const received = this.platform.push.onReceive(() => { if (this.state.session) void this.refresh().then(() => this.pollMessages()); });
    const resumed = this.platform.onResume(() => { if (this.state.session) void this.refresh().then(() => this.pollMessages()); });
    const installed = await Promise.allSettled([opened, received, resumed]);
    for (const result of installed) if (result.status === "fulfilled") this.cleanup.push(result.value);
    const onVisibility = () => { this.visible = !document.hidden; if (this.visible && this.state.session) void this.refresh().then(() => this.pollMessages()); };
    document.addEventListener("visibilitychange", onVisibility);
    this.cleanup.push(() => document.removeEventListener("visibilitychange", onVisibility));
    const polling = setInterval(() => { if (this.visible && this.state.session) void this.refresh().then(() => this.pollMessages()); }, 4000);
    this.cleanup.push(() => clearInterval(polling));
    try {
      const session = await this.api.restore();
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
    ++this.epoch;
    this.presenceAt = 0;
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
        if (Date.now() - this.presenceAt >= 15_000) {
          await this.api.presence(this.platform.kind);
          if (epoch !== this.epoch) return;
          this.presenceAt = Date.now();
        }
        const workspaces = await this.api.workspaces();
        if (epoch !== this.epoch) return;
        for (const [id] of this.connections) if (!workspaces.some(workspace => workspace.id === id && workspace.online)) this.evict(id);
        const results = await Promise.allSettled(workspaces.map(async workspace => {
          if (!workspace.online) return this.state.bots.filter(bot => bot.workspace.id === workspace.id).map(bot => ({ ...bot, workspace }));
          try {
            const reply = z.object({ bots: z.array(botSchema) }).parse(await (await this.connection(workspace)).request("/api/bots?messages=1"));
            return reply.bots.map(bot => ({ ...bot, workspace }));
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
        this.update({ workspaces, bots: merged, sourceErrors, error: "", ...(lostSelection ? { selected: null, selectedThread: null, messages: [], hasMore: false, sending: false, loadingMessages: false, chatError: "" } : {}) });
      } catch (error) { if (epoch === this.epoch) this.update({ error: errorMessage(error) }); }
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
    const epoch = this.epoch, historyEpoch = this.historyEpoch, key = conversationKey(bot);
    if (!quiet) this.update({ loadingMessages: true, chatError: "" });
    const flight = (async () => {
      try {
        const before = older ? this.state.messages[0]?.id : undefined;
        const path = `/api/threads/${bot.threadId}/messages?limit=50${before ? `&before=${encodeURIComponent(before)}` : ""}`;
        const page = messagePageSchema.parse(await (await this.connection(bot.workspace)).request(path));
        if (epoch !== this.epoch || historyEpoch !== this.historyEpoch) return;
        const overlap = page.hasMore ? this.state.messages.findIndex(message => message.id === page.messages[0]?.id) : -1;
        const prefix = older ? page.messages : overlap > 0 ? this.state.messages.slice(0, overlap) : [];
        const messages = older ? [...prefix, ...this.state.messages] : [...prefix, ...page.messages];
        const unique = [...new Map(messages.map(message => [message.id, message])).values()];
        const hasMore = !older && overlap > 0 ? this.state.hasMore : page.hasMore;
        this.cachedMessages.set(key, { messages: unique, hasMore });
        this.update({ messages: unique, hasMore, chatError: "" });
        if (this.visible) void (await this.connection(bot.workspace)).request(`/api/bots/${bot.id}/read`, { method: "POST", body: { threadId: bot.threadId } }).catch(() => {});
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
    const key = conversationKey(bot), value = this.state.drafts[key]?.trim();
    if (!value) return;
    const previous = this.sends.get(key);
    const send = previous?.text === value ? previous : { text: value, sendId: crypto.randomUUID() };
    this.sends.set(key, send);
    this.activeSends.add(key);
    const epoch = this.epoch, historyEpoch = this.historyEpoch;
    this.update({ sending: true, chatError: "" });
    try {
      await (await this.connection(bot.workspace)).request(`/api/bots/${bot.id}/messages`, { method: "POST", body: { ...send, threadId: bot.threadId } });
      if (epoch !== this.epoch) return;
      this.sends.delete(key);
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
  private openNotification(): void {
    const route = this.route;
    if (!route || route.accountId !== this.state.session?.account.id) { if (this.state.session) this.route = null; return; }
    const bot = this.state.bots.find(bot => bot.workspace.id === route.workspaceId && bot.id === route.botId && (bot.threadId === route.threadId || bot.tasks.some(task => task.threadId === route.threadId)));
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
    ++this.epoch; ++this.historyEpoch;
    this.state = initial(); this.update({ loading: true });
    this.refreshFlight = undefined; this.historyFlight = undefined;
    for (const id of this.connections.keys()) this.evict(id);
    this.cachedMessages.clear(); this.sends.clear(); this.activeSends.clear(); this.route = null;
    await this.pushFlight;
    if (this.platform.kind !== "web") {
      try { await this.api.unsubscribe(); } catch { }
      try { await this.platform.push.unregister(); } catch { }
    }
    try { await this.api.logout(); }
    finally { this.state = initial(); this.update({ phase: "login", push: this.platform.kind === "web" ? "unavailable" : "off" }); }
  }
  dispose(): void { this.cleanup.forEach(dispose => dispose()); this.cleanup = []; for (const id of this.connections.keys()) this.evict(id); }
}
