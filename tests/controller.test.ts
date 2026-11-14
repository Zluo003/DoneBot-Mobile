import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileApi } from "../src/core/api";
import { MobileController } from "../src/core/controller";
import { type NotificationRoute, type Platform, type PushRegistration, type WorkspaceConnection } from "../src/core/contracts";
import vectors from "./fixtures/e2e-v1.json";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const controllers: MobileController[] = [];
afterEach(() => { controllers.forEach(controller => controller.dispose()); controllers.length = 0; vi.unstubAllGlobals(); });

function fixture() {
  const values = new Map<string, string>();
  let open: (route: NotificationRoute) => void = () => {};
  const registration: PushRegistration = { token: "synthetic-apns", platform: "ios", environment: "sandbox" };
  const platform: Platform = {
    kind: "ios",
    vault: { read: async key => values.get(key) ?? null, write: async (key, value) => { values.set(key, value); }, remove: async key => { values.delete(key); } },
    push: {
      permission: vi.fn(async () => "granted" as const), register: vi.fn(async () => registration), unregister: vi.fn(async () => {}),
      onOpen: async listener => { open = listener; return () => {}; }, onReceive: async () => () => {},
    },
    onResume: async () => () => {},
  };
  const workspace = { id: "computer", name: "Fixture", kind: "computer", provisioned: true, online: true };
  const bots = ["one", "two"].map(id => ({ id, name: id, threadId: `thread-${id}`, unread: false, tasks: [{ threadId: `thread-${id}` }, { threadId: `other-${id}` }] }));
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith("/auth/login")) return Response.json({ access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_in: 3600, user: { id: "account", email: "fixture@donebot.test" } });
    if (url.endsWith("/mobile/workspaces")) return Response.json({ workspaces: [workspace] });
    if (url.endsWith("/connection")) return Response.json({ v: 1, k: vectors.V1.transportPublicB64u, h: vectors.V1.hostIdB64u, r: ["relay1.donebot.cn"], deviceToken: "omb_synthetic_only" });
    if (url.endsWith("/mobile/session") || url.endsWith("/subscription") || url.endsWith("/auth/logout")) return Response.json({ ok: true });
    throw new Error(`Unexpected fixture URL: ${url} ${options?.method}`);
  });
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("document", Object.assign(new EventTarget(), { hidden: false }));
  const request = vi.fn(async (path: string, _options?: { method?: string; body?: unknown }): Promise<unknown> => {
    if (path.startsWith("/api/bots?")) return { bots: structuredClone(bots) };
    if (path.startsWith("/api/threads/")) return { messages: [], hasMore: false };
    return { ok: true };
  });
  const api = new MobileApi(platform.vault);
  const connection: WorkspaceConnection = { request: request as WorkspaceConnection["request"], close: vi.fn() };
  const controller = new MobileController(api, platform, async () => connection);
  controllers.push(controller);
  return { controller, api, platform, request, fetcher, values, bots, registration, open: (route: NotificationRoute) => open(route), login: () => controller.login("fixture@donebot.test", "synthetic-password") };
}

describe("conversation isolation", () => {
  it("keeps each Bot's in-flight send across navigation without duplicate sends", async () => {
    const fx = fixture(); await fx.login();
    const [one, two] = fx.controller.snapshot().bots;
    await fx.controller.select(one); fx.controller.setDraft("hello");
    const held = deferred<{ ok: true }>();
    const original = fx.request.getMockImplementation()!;
    fx.request.mockImplementation((path, options) => path.endsWith("/messages") && options?.method === "POST" ? held.promise : original(path, options));
    const sending = fx.controller.send();
    expect(fx.controller.snapshot().sending).toBe(true);
    await fx.controller.select(two); expect(fx.controller.snapshot().sending).toBe(false);
    await fx.controller.select(one); expect(fx.controller.snapshot().sending).toBe(true);
    await fx.controller.send();
    expect(fx.request.mock.calls.filter(([, options]) => options?.method === "POST" && (options.body as { text?: string }).text)).toHaveLength(1);
    held.resolve({ ok: true }); await sending;
    expect(fx.controller.snapshot().sending).toBe(false);
  });

  it("retains the sendId for a manual retry after an uncertain delivery", async () => {
    const fx = fixture(); await fx.login(); await fx.controller.select(fx.controller.snapshot().bots[0]);
    fx.controller.setDraft("keep this request");
    const original = fx.request.getMockImplementation()!;
    fx.request.mockImplementation(async (path, options) => {
      if (path.endsWith("/messages") && options?.method === "POST") throw new Error("Synthetic lost acknowledgement");
      return original(path, options);
    });
    await fx.controller.send(); await fx.controller.send();
    const sends = fx.request.mock.calls.filter(([, options]) => (options?.body as { sendId?: string })?.sendId);
    expect(sends).toHaveLength(2); expect(sends[0][1]?.body).toEqual(sends[1][1]?.body);
    expect(Object.values(fx.controller.snapshot().drafts)).toEqual(["keep this request"]);
  });

  it("keeps loaded history when a new page arrives", async () => {
    const fx = fixture(); await fx.login();
    const message = (id: string) => ({ id, role: "bot", text: id });
    const pages = [
      { messages: [message("m3"), message("m4")], hasMore: true },
      { messages: [message("m1"), message("m2")], hasMore: false },
      { messages: [message("m4"), message("m5")], hasMore: true },
    ];
    const original = fx.request.getMockImplementation()!;
    fx.request.mockImplementation(async (path, options) => path.startsWith("/api/threads/") ? pages.shift()! : original(path, options));
    await fx.controller.select(fx.controller.snapshot().bots[0]);
    await fx.controller.loadMessages(true); await fx.controller.pollMessages();
    expect(fx.controller.snapshot().messages.map(message => message.id)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    expect(fx.controller.snapshot().hasMore).toBe(false);
  });

  it("pins the displayed conversation when another client selects a different task", async () => {
    const fx = fixture(); await fx.login(); await fx.controller.select(fx.controller.snapshot().bots[0]);
    fx.bots[0].threadId = "other-one"; await fx.controller.refresh();
    fx.controller.setDraft("send to the displayed conversation"); await fx.controller.send();
    const send = fx.request.mock.calls.find(([, options]) => (options?.body as { text?: string })?.text);
    expect(send?.[1]?.body).toMatchObject({ threadId: "thread-one" });
  });

  it("returns to the list when the selected Bot is removed or access is revoked", async () => {
    const fx = fixture(); await fx.login(); await fx.controller.select(fx.controller.snapshot().bots[0]);
    fx.bots.splice(0, 1); await fx.controller.refresh();
    expect(fx.controller.snapshot().selected).toBeNull();
    expect(fx.controller.snapshot().messages).toEqual([]);
  });
});

describe("notification accounts and revocation", () => {
  it("opens only an owned Bot conversation for the signed-in account", async () => {
    const fx = fixture(); await fx.controller.boot(); await fx.login();
    const route = { accountId: "someone-else", workspaceId: "computer", botId: "one", threadId: "thread-one" };
    fx.open(route); await fx.controller.refresh();
    expect(fx.controller.snapshot().selected).toBeNull();
    fx.open({ ...route, accountId: "account", threadId: "other-one" });
    await vi.waitFor(() => expect(fx.controller.selectedBot()?.threadId).toBe("other-one"));
  });

  it("does not restore a notification preference that the user disabled", async () => {
    const fx = fixture(); fx.values.set("donebot.push.account", "off");
    await fx.login(); await Promise.resolve();
    expect(fx.platform.push.register).not.toHaveBeenCalled();
  });

  it("cannot subscribe after logout while APNs registration is pending", async () => {
    const fx = fixture(); await fx.login();
    const held = deferred<PushRegistration>(); vi.mocked(fx.platform.push.register).mockReturnValue(held.promise);
    const enabling = fx.controller.enablePush(), leaving = fx.controller.logout();
    expect(fx.controller.snapshot().session).toBeNull();
    held.resolve(fx.registration); await Promise.all([enabling, leaving]);
    expect(fx.fetcher.mock.calls.some(([url, options]) => url.endsWith("/subscription") && options?.method === "PUT")).toBe(false);
    expect(fx.controller.snapshot().phase).toBe("login");
  });

  it("revokes a binding after its pending subscription completes", async () => {
    const fx = fixture(); await fx.login();
    const held = deferred<Response>(), operations: string[] = [];
    const original = fx.fetcher.getMockImplementation()!;
    fx.fetcher.mockImplementation(async (url, options) => {
      if (url.endsWith("/subscription")) { operations.push(options!.method!); if (options?.method === "PUT") return held.promise; }
      return original(url, options);
    });
    const enabling = fx.controller.enablePush();
    await vi.waitFor(() => expect(operations).toEqual(["PUT"]));
    const leaving = fx.controller.logout(); held.resolve(Response.json({ ok: true }));
    await Promise.all([enabling, leaving]);
    expect(operations).toEqual(["PUT", "DELETE"]);
    expect(fx.api.current()).toBeNull(); expect(fx.values.has("donebot.session.v1")).toBe(false);
  });
});
