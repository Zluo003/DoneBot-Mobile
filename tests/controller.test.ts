import { afterEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { indexedDBStorage } from "../src/platform/cache";
import { cachedFileKey } from "../src/core/offline";
import { MobileApi } from "../src/core/api";
import { MobileController } from "../src/core/controller";
import { messageSchema, type NotificationRoute, type Platform, type PushRegistration, type WorkspaceConnection } from "../src/core/contracts";
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
    cache: indexedDBStorage(`test-${crypto.randomUUID()}`),
    media: { pickImages: async () => [], fileAction: async () => {}, clear: async () => {} },
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

describe("offline conversations and automatic file caching", () => {
  function withFiles() {
    const fx = fixture(), original = fx.request.getMockImplementation()!;
    const message = messageSchema.parse({ id: "synced", role: "bot", text: "离线也要保留的消息\n\n![图片](/picture.png)\n\n[文档](/report.pdf)\n\n[视频](/movie.mp4)" });
    fx.request.mockImplementation(async (path, options) => {
      if (path.startsWith("/api/bots?")) return { bots: fx.bots.map((bot, index) => ({ ...bot, messages: index === 0 ? [message] : [] })) };
      if (path.endsWith("/file")) {
        const name = (options?.body as { path: string }).path.slice(1);
        return { data: new TextEncoder().encode(`contents:${name}`), mime: name.endsWith(".png") ? "image/png" : name.endsWith(".mp4") ? "video/mp4" : "application/pdf", name };
      }
      if (path.startsWith("/api/threads/")) return { messages: [message], hasMore: false };
      return original(path, options);
    });
    return fx;
  }
  it("downloads photos, videos and documents from synchronized messages before they are opened", async () => {
    const fx = withFiles(); await fx.login();
    const bot = fx.controller.snapshot().bots[0];
    expect(fx.controller.snapshot().selected).toBeNull();
    await vi.waitFor(async () => {
      for (const path of ["/picture.png", "/movie.mp4", "/report.pdf"]) expect(await fx.platform.cache.hasFile("account", cachedFileKey(bot, "synced", path))).toBe(true);
    });
    expect(fx.request.mock.calls.filter(([path]) => path.endsWith("/file"))).toHaveLength(3);
    await fx.controller.file(bot, "synced", "/picture.png"); await fx.controller.refresh();
    expect(fx.request.mock.calls.filter(([path]) => path.endsWith("/file"))).toHaveLength(3);
  });
  it("restores expired local identity, Bots, messages and file bytes after an offline restart", async () => {
    const fx = withFiles(); await fx.login();
    const bot = fx.controller.snapshot().bots[0];
    await fx.controller.select(bot);
    await vi.waitFor(async () => expect(await fx.platform.cache.hasFile("account", cachedFileKey(bot, "synced", "/movie.mp4"))).toBe(true));
    const session = JSON.parse(fx.values.get("donebot.session.v1")!); session.expiresAt = 1;
    fx.values.set("donebot.session.v1", JSON.stringify(session));
    fx.controller.dispose();
    fx.fetcher.mockRejectedValue(new Error("Airplane mode"));
    const connect = vi.fn(async () => { throw new Error("No network"); });
    const restarted = new MobileController(new MobileApi(fx.platform.vault), fx.platform, connect); controllers.push(restarted);
    await restarted.boot();
    expect(restarted.snapshot().phase).toBe("ready"); expect(restarted.snapshot().offline).toBe(true);
    expect(restarted.snapshot().bots).toHaveLength(2);
    await restarted.select(restarted.snapshot().bots[0]);
    expect(restarted.snapshot().messages[0].text).toContain("离线也要保留");
    const movie = await restarted.file(restarted.selectedBot()!, "synced", "/movie.mp4");
    expect(new TextDecoder().decode(movie.data)).toBe("contents:movie.mp4");
    expect(connect).not.toHaveBeenCalled(); expect(fx.values.has("donebot.session.v1")).toBe(true);
    await expect(restarted.file(restarted.selectedBot()!, "never-synced", "/absent.pdf")).rejects.toThrow("尚未缓存");
  });
  it("removes account data after pending disk writes and prevents a late transfer from recreating it", async () => {
    const fx = fixture(); await fx.login(); const bot = fx.controller.snapshot().bots[0];
    const held = deferred<void>(), write = fx.platform.cache.writeFile;
    const writing = vi.fn(async (...args: Parameters<typeof write>) => { await held.promise; await write(...args); });
    fx.platform.cache.writeFile = writing;
    const original = fx.request.getMockImplementation()!;
    fx.request.mockImplementation(async (path, options) => path.endsWith("/file") ? { data: new Uint8Array([1, 2]), mime: "application/pdf", name: "file.pdf" } : original(path, options));
    const reading = fx.controller.file(bot, "message", "/file.pdf");
    const result = expect(reading).rejects.toThrow("账号已切换");
    await vi.waitFor(() => expect(writing).toHaveBeenCalledOnce());
    const leaving = fx.controller.logout(); held.resolve(); await Promise.all([leaving, result]);
    expect(await fx.platform.cache.readState("account")).toBeNull();
    expect(await fx.platform.cache.hasFile("account", cachedFileKey(bot, "message", "/file.pdf"))).toBe(false);
  });
  it("never shows another account's cached Bots when switching accounts", async () => {
    const fx = fixture(); await fx.login();
    const original = fx.fetcher.getMockImplementation()!;
    fx.fetcher.mockImplementation(async (url, options) => url.endsWith("/auth/login") ? Response.json({ access_token: "different-access", refresh_token: "different-refresh", expires_in: 3600, user: { id: "different", email: "different@fixture.test" } }) : url.endsWith("/mobile/workspaces") ? Promise.reject(new Error("Offline")) : original(url, options));
    await fx.controller.login("different@fixture.test", "synthetic-password");
    expect(fx.controller.snapshot().session?.account.id).toBe("different");
    expect(fx.controller.snapshot().bots).toEqual([]); expect(fx.controller.snapshot().messages).toEqual([]);
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

describe("mobile attachment isolation", () => {
  it("sends an image without text and preserves upload and send identities on retry", async () => {
    const fx = fixture(); await fx.login(); await fx.controller.select(fx.controller.snapshot().bots[0]);
    const blob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
    fx.platform.media.pickImages = async () => [{ name: '图&".png', blob }];
    await fx.controller.pickImages("library");
    const original = fx.request.getMockImplementation()!;
    let delivered = false;
    fx.request.mockImplementation(async (path, options) => {
      if (path.startsWith("/api/attachments?")) return { path: "/private/picture.png", mime: "image/png", bytes: blob.size };
      if (path.endsWith("/messages") && options?.method === "POST") {
        if (!delivered) throw new Error("Synthetic lost acknowledgement");
        return { ok: true };
      }
      return original(path, options);
    });
    await fx.controller.send(); delivered = true; await fx.controller.send();
    const uploads = fx.request.mock.calls.filter(([path]) => path.startsWith("/api/attachments?"));
    const sends = fx.request.mock.calls.filter(([, options]) => (options?.body as { sendId?: string })?.sendId);
    expect(uploads).toHaveLength(1);
    expect(sends).toHaveLength(2); expect(sends[0][1]?.body).toEqual(sends[1][1]?.body);
    expect(sends[0][1]?.body).toMatchObject({ text: '<attached-image path="/private/picture.png" name="图&amp;&quot;.png" />', threadId: "thread-one" });
    expect(Object.values(fx.controller.snapshot().images).flat()).toEqual([]);
  });
  it("keeps an image picker result with its originating Bot across navigation", async () => {
    const fx = fixture(); await fx.login();
    const [one, two] = fx.controller.snapshot().bots;
    await fx.controller.select(one);
    const picked = deferred<Array<{ name: string; blob: Blob }>>();
    fx.platform.media.pickImages = () => picked.promise;
    const selecting = fx.controller.pickImages("camera");
    await fx.controller.select(two);
    picked.resolve([{ name: "camera.png", blob: new Blob(["image"], { type: "image/png" }) }]); await selecting;
    expect(fx.controller.snapshot().images["computer/one/thread-one"]).toHaveLength(1);
    expect(fx.controller.snapshot().images["computer/two/thread-two"]).toBeUndefined();
    await fx.controller.send();
    expect(fx.request.mock.calls.some(([, options]) => (options?.body as { sendId?: string })?.sendId)).toBe(false);
  });
  it("rejects late media results after logout and aborts the file request", async () => {
    const fx = fixture(); await fx.login();
    const bot = fx.controller.snapshot().bots[0];
    const held = deferred<unknown>(); const original = fx.request.getMockImplementation()!;
    let signal: AbortSignal | undefined;
    fx.request.mockImplementation((path, options) => {
      if (path.endsWith("/file")) { signal = (options as { signal?: AbortSignal }).signal; return held.promise; }
      return original(path, options);
    });
    const reading = fx.controller.file(bot, "message", "/file.pdf");
    await vi.waitFor(() => expect(signal).toBeDefined());
    await fx.controller.logout(); expect(signal!.aborted).toBe(true);
    held.resolve({ data: new Uint8Array([1]), mime: "application/pdf", name: "file.pdf" });
    await expect(reading).rejects.toThrow("账号已切换");
  });
});

describe("departments and group conversations", () => {
  it("keeps department metadata and sends and reads a group through the original group routes", async () => {
    const fx = fixture(), original = fx.request.getMockImplementation()!;
    const replies = [
      { id: "reply", role: "bot", text: "A Bot reply", from: { botId: "one", name: "One" } },
      { id: "user", role: "user", text: "A later user message" },
    ];
    fx.request.mockImplementation(async (path, options) => {
      if (path.startsWith("/api/bots?")) return { bots: fx.bots.map((bot, index) => ({ ...bot, defaultBot: index === 0 ? {} : undefined, chiefOfStaff: true, section: index ? "Studio" : undefined })), sections: ["Studio"], groups: [{ id: "room", name: "Design room", threadId: "group-thread", memberIds: ["one", "two"], section: "Studio", working: true, messages: replies }] };
      if (path.startsWith("/api/threads/group-thread/")) return { messages: replies, hasMore: false };
      return original(path, options);
    });
    await fx.login();
    expect(fx.request).toHaveBeenCalledWith("/api/bots?messages=20");
    expect(fx.controller.snapshot().sections).toEqual({ computer: ["Studio"] });
    expect(fx.controller.snapshot().sourceErrors).toEqual({});
    expect(fx.controller.snapshot().bots[0]).toMatchObject({ defaultBot: {}, chiefOfStaff: true, workspace: { online: true } });
    const group = fx.controller.snapshot().bots.find(bot => bot.conversationKind === "group")!;
    expect(group).toMatchObject({ id: "room", memberIds: ["one", "two"], busy: true, section: "Studio" });
    await fx.controller.select(group);
    expect(fx.request).toHaveBeenCalledWith("/api/groups/room/read", expect.objectContaining({ method: "POST" }));
    expect(fx.controller.snapshot().messages[0].from?.name).toBe("One");
    fx.controller.setDraft("Discuss this"); await fx.controller.send();
    expect(fx.request).toHaveBeenCalledWith("/api/groups/room/messages", expect.objectContaining({ method: "POST", body: expect.objectContaining({ text: "Discuss this", threadId: "group-thread" }) }));
    const saved = JSON.parse((await fx.platform.cache.readState("account"))!) as { sections: Record<string, string[]>; bots: Array<{ id: string; conversationKind?: string }> };
    expect(saved?.sections).toEqual({ computer: ["Studio"] });
    expect(saved?.bots.find(bot => bot.id === "room")?.conversationKind).toBe("group");
  });
});

describe("push configuration diagnostics", () => {
  it("reports missing gateway APNs configuration without claiming reminders are enabled", async () => {
    const fx = fixture(); await fx.login();
    const original = fx.fetcher.getMockImplementation()!;
    fx.fetcher.mockImplementation(async (url, options) => url.endsWith("/subscription") && options?.method === "PUT" ? Response.json({ code: 503, reason: "MOBILE_PUSH_UNAVAILABLE", message: "unavailable" }, { status: 503 }) : original(url, options));
    await fx.controller.enablePush();
    expect(fx.controller.snapshot().pushError).toContain("管理后台配置 APNs");
    expect(fx.controller.snapshot().push).not.toBe("on");
    fx.fetcher.mockImplementation(original); await fx.controller.enablePush();
    expect(fx.controller.snapshot().push).toBe("on");
  });
});


describe("directory data errors and recovery", () => {
  it("retains synchronized Bots without showing raw validation JSON, then recovers on refresh", async () => {
    const fx = fixture(); await fx.login();
    const original = fx.request.getMockImplementation()!;
    fx.request.mockImplementation(async (path, options) => path.startsWith("/api/bots?") ? { bots: [{ ...fx.bots[0], defaultBot: "invalid" }] } : original(path, options));
    await fx.controller.refresh();
    expect(fx.controller.snapshot().sourceErrors.computer).toBe("收到的数据暂不兼容，请更新 App 后重试。");
    expect(fx.controller.snapshot().bots).toHaveLength(2);
    fx.request.mockImplementation(async (path, options) => path.startsWith("/api/bots?") ? { bots: [{ ...fx.bots[0], defaultBot: {} }] } : original(path, options));
    await fx.controller.refresh();
    expect(fx.controller.snapshot().sourceErrors).toEqual({});
    expect(fx.controller.snapshot().bots[0].workspace.online).toBe(true);
  });
});

describe("workspace automations and connected apps", () => {
  const routine = { id: "daily", name: "Daily brief", botId: "one", enabled: true, prompt: "Keep this instruction", nextRunAt: null };
  function setup() {
    const fx = fixture(), original = fx.request.getMockImplementation()!;
    fx.request.mockImplementation(async (path, options) => {
      if (path === "/api/routines") return { routines: [routine] };
      if (path === "/api/webhooks") return { webhooks: [{ ...routine, id: "hook" }] };
      if (path === "/api/app-triggers") return { triggers: [{ ...routine, id: "event" }] };
      if (path === "/api/connectors/connected") return { services: { gmail: { connected: true, accounts: [{ id: "gmail", status: "ACTIVE", alias: "fixture@donebot.test" }], secret: "must-not-reach-state" } } };
      if (path.startsWith("/api/routines/")) return { routine: { ...routine, ...(options?.body as object) } };
      if (path.includes("/enabled")) return { [path.includes("webhooks") ? "webhook" : "trigger"]: { ...routine, id: path.split("/")[3], ...(options?.body as object) } };
      return original(path, options);
    });
    return fx;
  }
  it("loads all automation kinds and only the public application status fields", async () => {
    const fx = setup(); await fx.login();
    await Promise.all([fx.controller.loadWorkspaceData("computer", "automations"), fx.controller.loadWorkspaceData("computer", "apps")]);
    expect(fx.controller.snapshot().automations.computer.map(item => item.kind)).toEqual(["schedule", "webhook", "app"]);
    expect(fx.controller.snapshot().apps.computer[0]).toMatchObject({ id: "gmail", accounts: [{ alias: "fixture@donebot.test" }] });
    expect(JSON.stringify(fx.controller.snapshot().apps)).not.toContain("must-not-reach-state");
    expect(fx.controller.snapshot().workspaceLoading).toEqual({ "automations/computer": false, "apps/computer": false });
  });
  it("writes only enabled, uses each original endpoint, and cannot write while offline", async () => {
    const fx = setup(); await fx.login(); await fx.controller.loadWorkspaceData("computer", "automations");
    for (const item of fx.controller.snapshot().automations.computer) await fx.controller.setAutomationEnabled("computer", item, false);
    for (const [path, method] of [["/api/routines/daily", "PATCH"], ["/api/webhooks/hook/enabled", "POST"], ["/api/app-triggers/event/enabled", "POST"]]) {
      expect(fx.request).toHaveBeenCalledWith(path, { method, body: { enabled: false } });
    }
    expect(fx.controller.snapshot().automations.computer.every(item => !item.enabled && item.prompt === routine.prompt)).toBe(true);
    const original = fx.fetcher.getMockImplementation()!;
    fx.fetcher.mockImplementation(async (url, options) => url.endsWith("/mobile/workspaces") ? Response.json({ workspaces: [{ id: "computer", name: "Fixture", kind: "computer", online: false, provisioned: true }] }) : original(url, options));
    await fx.controller.refresh(); fx.request.mockClear();
    await fx.controller.setAutomationEnabled("computer", fx.controller.snapshot().automations.computer[0], true);
    expect(fx.request).not.toHaveBeenCalled();
    expect(fx.controller.snapshot().workspaceErrors["automations/computer"]).toContain("设备离线");
  });
  it("keeps the actual switch state after a failed write and discards a stale poll during a write", async () => {
    const fx = setup(); await fx.login(); await fx.controller.loadWorkspaceData("computer", "automations");
    const original = fx.request.getMockImplementation()!;
    fx.request.mockImplementation(async (path, options) => { if (options?.method === "PATCH") throw new Error("连接中断"); return original(path, options); });
    await fx.controller.setAutomationEnabled("computer", fx.controller.snapshot().automations.computer[0], false);
    expect(fx.controller.snapshot().automations.computer[0].enabled).toBe(true);
    expect(fx.controller.snapshot().workspaceErrors["automations/computer"]).toBe("连接中断");
    const held = deferred<unknown>();
    fx.request.mockImplementation((path, options) => path === "/api/routines" ? held.promise : original(path, options));
    const polling = fx.controller.loadWorkspaceData("computer", "automations");
    await fx.controller.setAutomationEnabled("computer", fx.controller.snapshot().automations.computer[0], false);
    held.resolve({ routines: [routine] }); await polling;
    expect(fx.controller.snapshot().automations.computer[0].enabled).toBe(false);
    expect(fx.controller.snapshot().automationBusy).toEqual([]);
  });
  it("does not restore workspace data from a response arriving after logout", async () => {
    const fx = setup(); await fx.login();
    const held = deferred<unknown>(), original = fx.request.getMockImplementation()!;
    fx.request.mockImplementation((path, options) => path === "/api/routines" ? held.promise : original(path, options));
    const loading = fx.controller.loadWorkspaceData("computer", "automations");
    await fx.controller.logout(); held.resolve({ routines: [routine] }); await loading;
    expect(fx.controller.snapshot().automations).toEqual({});
    expect(fx.controller.snapshot().phase).toBe("login");
  });
});
