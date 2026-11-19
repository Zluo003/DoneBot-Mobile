import { z } from "zod";
import { accountSchema, descriptorSchema, sessionSchema, workspacesSchema, visibleWorkspaces, type Session, type SecureVault, type PushRegistration } from "./contracts";

const configured = import.meta.env.VITE_DONEBOT_ORIGIN || "https://donebot.cn";
const endpoint = new URL(configured);
if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash) {
  throw new Error("DoneBot 服务地址必须是 HTTPS origin。");
}
export const apiOrigin = __FIXTURE__ ? location.origin : endpoint.origin;
const loginSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1).optional(), expires_in: z.number().positive().optional(), user: accountSchema });
const challengeSchema = z.object({ requires_2fa: z.literal(true), temp_token: z.string().min(1) });
const SESSION_KEY = "donebot.session.v1";
const INSTALLATION_KEY = "donebot.mobile-installation.v1";

async function errorReason(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4096) { void reader.cancel().catch(() => {}); return ""; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return z.object({ reason: z.string().max(80) }).safeParse(value).data?.reason ?? "";
  } catch { return ""; }
  finally { reader.releaseLock(); }
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export class MobileApi {
  private session: Session | null = null;
  private epoch = 0;
  private refreshFlight: Promise<void> | undefined;
  private persistence: Promise<void> = Promise.resolve();
  private installationFlight: Promise<string> | undefined;
  constructor(readonly vault: SecureVault, readonly origin = apiOrigin) {}
  current(): Session | null { return this.session; }
  private persist(session: Session | null): Promise<void> {
    const operation = this.persistence.catch(() => {}).then(() => session ? this.vault.write(SESSION_KEY, JSON.stringify(session)) : this.vault.remove(SESSION_KEY));
    this.persistence = operation;
    return operation;
  }
  async restore(): Promise<Session | null> {
    const epoch = this.epoch;
    const saved = await this.vault.read(SESSION_KEY);
    if (epoch !== this.epoch || !saved) return this.session;
    try { this.session = sessionSchema.parse(JSON.parse(saved)); }
    catch { await this.persist(null); return null; }
    // Restore local identity without requiring a network. Authorized requests refresh
    // expired credentials before sending; cached conversations remain readable offline.
    return this.session;
  }
  async raw(path: string, body?: unknown, token?: string, method?: string): Promise<unknown> {
    const response = await fetch(this.origin + path, {
      method: method ?? (body === undefined ? "GET" : "POST"), redirect: "error", credentials: "omit",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      const reason = await errorReason(response);
      const subscription = path === "/api/v1/donebot/mobile/push/subscription";
      const text = subscription && response.status === 503 && ["", "MOBILE_PUSH_UNAVAILABLE"].includes(reason)
        ? "网关尚未启用 Apple 消息推送，请在管理后台配置 APNs 后重试。"
        : reason === "MOBILE_RELAY_OFFLINE" ? "中继节点暂时离线，请稍后重新连接。"
        : reason === "MOBILE_UNAVAILABLE" ? "网关尚未配置手机连接，请联系管理员。"
        : response.status === 401 ? (path === "/api/v1/auth/login" ? "邮箱或密码不正确。" : path === "/api/v1/auth/login/2fa" ? "验证码不正确或已过期。" : "登录状态已失效，请重新登录。") : response.status === 404 || response.status === 501
        ? "手机连接服务尚未启用，请稍后重试。" : response.status === 429 ? "操作较频繁，请稍后重试。" : "暂时无法完成请求，请稍后重试。";
      throw new ApiError(response.status, text);
    }
    if (response.status === 204) return null;
    const value: unknown = await response.json();
    const envelope = z.object({ code: z.number(), data: z.unknown() }).safeParse(value);
    if (envelope.success) {
      if (envelope.data.code !== 0) throw new ApiError(502, "服务暂时无法完成请求。");
      return envelope.data.data;
    }
    return value;
  }
  async login(email: string, password: string): Promise<{ challenge: string } | { session: Session }> {
    const epoch = ++this.epoch;
    this.refreshFlight = undefined;
    const value = await this.raw("/api/v1/auth/login", { email, password });
    if (epoch !== this.epoch) throw new Error("登录操作已取消。");
    const challenge = challengeSchema.safeParse(value);
    if (challenge.success) return { challenge: challenge.data.temp_token };
    return { session: await this.accept(value, epoch) };
  }
  async verify(challenge: string, code: string): Promise<Session> {
    const epoch = this.epoch;
    return this.accept(await this.raw("/api/v1/auth/login/2fa", { temp_token: challenge, totp_code: code }), epoch);
  }
  private async accept(value: unknown, epoch: number): Promise<Session> {
    const login = loginSchema.parse(value);
    if (epoch !== this.epoch) throw new Error("账号已切换。");
    const session: Session = { accessToken: login.access_token, refreshToken: login.refresh_token, expiresAt: Date.now() + (login.expires_in ?? 900) * 1000, account: login.user };
    await this.persist(session);
    if (epoch !== this.epoch) throw new Error("账号已切换。");
    this.session = session;
    return session;
  }
  private async refresh(): Promise<void> {
    if (this.refreshFlight) return this.refreshFlight;
    const epoch = this.epoch;
    const session = this.session;
    if (!session?.refreshToken) throw new ApiError(401, "请重新登录。");
    const flight = (async () => {
      const value = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1).optional(), expires_in: z.number().positive() }).parse(await this.raw("/api/v1/auth/refresh", { refresh_token: session.refreshToken }));
      if (epoch !== this.epoch) throw new Error("账号已切换。");
      const updated = { ...session, accessToken: value.access_token, refreshToken: value.refresh_token ?? session.refreshToken, expiresAt: Date.now() + value.expires_in * 1000 };
      await this.persist(updated);
      if (epoch === this.epoch) this.session = updated;
    })();
    this.refreshFlight = flight;
    void flight.finally(() => { if (this.refreshFlight === flight) this.refreshFlight = undefined; }).catch(() => {});
    return flight;
  }
  async authorized(path: string, body?: unknown, method?: string): Promise<unknown> {
    const epoch = this.epoch;
    if (!this.session) throw new ApiError(401, "请先登录。");
    if (this.session.expiresAt <= Date.now() + 60_000) await this.refresh();
    if (epoch !== this.epoch || !this.session) throw new ApiError(401, "账号已切换。");
    const result = await this.raw(path, body, this.session.accessToken, method);
    if (epoch !== this.epoch) throw new ApiError(401, "账号已切换。");
    return result;
  }
  async workspaces() { return visibleWorkspaces(workspacesSchema.parse(await this.authorized("/api/v1/donebot/mobile/workspaces")).workspaces); }
  async removeComputer(id: string): Promise<void> {
    await this.authorized(`/api/v1/donebot/installations/${encodeURIComponent(id)}`, undefined, "DELETE");
  }
  async presence(platform: string): Promise<void> {
    await this.authorized("/api/v1/donebot/mobile/session", { installationId: await this.installationId(), name: platform === "ios" ? "DoneBot iPhone" : "DoneBot Mobile", platform }, "PUT");
  }
  async connection(id: string) { return descriptorSchema.parse(await this.authorized(`/api/v1/donebot/mobile/workspaces/${encodeURIComponent(id)}/connection`, { installationId: await this.installationId() })); }
  async installationId(): Promise<string> {
    if (this.installationFlight) return this.installationFlight;
    const flight = (async () => {
      const saved = await this.vault.read(INSTALLATION_KEY);
      if (saved) return saved;
      const value = crypto.randomUUID(); await this.vault.write(INSTALLATION_KEY, value); return value;
    })();
    this.installationFlight = flight;
    void flight.catch(() => { if (this.installationFlight === flight) this.installationFlight = undefined; });
    return flight;
  }
  async subscribe(registration: PushRegistration): Promise<void> {
    await this.authorized("/api/v1/donebot/mobile/push/subscription", { ...registration, installationId: await this.installationId(), preview: false }, "PUT");
  }
  async unsubscribe(): Promise<void> {
    await this.authorized("/api/v1/donebot/mobile/push/subscription", { installationId: await this.installationId() }, "DELETE");
  }
  async logout(): Promise<void> {
    const old = this.session;
    ++this.epoch; this.session = null; this.refreshFlight = undefined;
    await this.persist(null);
    if (old) {
      try { const installationId = await this.vault.read(INSTALLATION_KEY); if (installationId) await this.raw("/api/v1/donebot/mobile/session", { installationId }, old.accessToken, "DELETE"); } catch { }
    }
    if (old?.refreshToken) {
      try { await this.raw("/api/v1/auth/logout", { refresh_token: old.refreshToken }, old.accessToken); } catch { }
    }
  }
}
