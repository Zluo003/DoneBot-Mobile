import { afterEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { indexedDBStorage } from "../src/platform/cache";
import { cachedFileKey } from "../src/core/offline";
import { MobileApi } from "../src/core/api";
import { MobileController } from "../src/core/controller";
import { messageSchema, type NotificationRoute, type Platform, type PushRegistration, type RequestOptions, type WorkspaceConnection } from "../src/core/contracts";
import { FILE_SEGMENT_BYTES } from "../src/core/file-download";
import { TransferError } from "../src/core/transfer-error";
import vectors from "./fixtures/e2e-v1.json";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const controllers: MobileController[] = [];
afterEach(() => { controllers.forEach(controller => controller.dispose()); controllers.length = 0; vi.unstubAllGlobals(); vi.useRealTimers(); });

function fixture() {
  const values = new Map<string, string>();
  let open: (route: NotificationRoute) => void = () => {};
  let activeChange: (active: boolean) => void = () => {};
  const registration: PushRegistration = { token: "synthetic-apns", platform: "ios", environment: "sandbox" };
  const platform: Platform = {
    kind: "ios",
    cache: indexedDBStorage(`test-${crypto.randomUUID()}`),
    media: { pickImages: async () => [], pickDocuments: async () => [], fileAction: async () => {}, clear: async () => {} },
    vault: { read: async key => values.get(key) ?? null, write: async (key, value) => { values.set(key, value); }, remove: async key => { values.delete(key); } },
    push: {
      permission: vi.fn(async () => "granted" as const), register: vi.fn(async () => registration), unregister: vi.fn(async () => {}),
      onOpen: async listener => { open = listener; return () => {}; }, onReceive: async () => () => {},
    },
    onActiveChange: async listener => { activeChange = listener; return () => {}; },
  };
  const workspace = { id: "computer", name: "Fixture", kind: "computer", provisioned: true, online: true };
  const workspaces = [workspace];
  const bots = ["one", "two"].map(id => ({ id, name: id, threadId: `thread-${id}`, unread: false, tasks: [{ threadId: `thread-${id}` }, { threadId: `other-${id}` }] }));
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith("/auth/login")) return Response.json({ access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_in: 3600, user: { id: "account", email: "fixture@donebot.test" } });
    if (url.endsWith("/mobile/workspaces")) return Response.json({ workspaces });
    if (url.endsWith("/connection")) return Response.json({ v: 1, k: vectors.V1.transportPublicB64u, h: vectors.V1.hostIdB64u, r: ["relay1.donebot.cn"], deviceToken: "omb_synthetic_only" });
    if (url.endsWith("/mobile/session") || url.endsWith("/subscription") || url.endsWith("/auth/logout")) return Response.json({ ok: true });
    throw new Error(`Unexpected fixture URL: ${url} ${options?.method}`);
  });
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("document", Object.assign(new EventTarget(), { hidden: false }));
  const request = vi.fn(async (path: string, _options?: RequestOptions): Promise<unknown> => {
    if (path.startsWith("/api/bots?")) return { bots: structuredClone(bots) };
    if (path.startsWith("/api/threads/")) return { messages: [], hasMore: false };
    return { ok: true };
  });
  const api = new MobileApi(platform.vault);
  const connection: WorkspaceConnection = { request: request as WorkspaceConnection["request"], close: vi.fn() };
  const connect = vi.fn(async () => connection);
  const controller = new MobileController(api, platform, connect);
  controllers.push(controller);
  return { controller, api, platform, request, connection, connect, fetcher, values, bots, registration, workspace, workspaces, active: (value: boolean) => activeChange(value), open: (route: NotificationRoute) => open(route), login: () => controller.login("fixture@donebot.test", "synthetic-password") };
}

describe("conversation isolation", () => {
  it("keeps offline devices with their saved names without merging devices that share a name", async () => {
    const fx = fixture();
    fx.workspace.name = "家里的电脑";
    fx.workspaces.push({ ...fx.workspace, id: "offline-one", online: false }, { ...fx.workspace, id: "offline-two", online: false });
    await fx.login();
    expect(fx.controller.snapshot().workspaces.map(({ id, name, online }) => ({ id, name, online }))).toEqual([
      { id: "computer", name: "家里的电脑", online: true },
      { id: "offline-one", name: "家里的电脑", online: false },
      { id: "offline-two", name: "家里的电脑", online: false },
    ]);
    expect(fx.connect).toHaveBeenCalledTimes(1);
  });

  it("removes only an offline computer after a successful account-scoped request", async () => {
    const fx = fixture();
    fx.workspaces.push({ ...fx.workspace, id: "old-computer", online: false });
    await fx.login();
    await expect(fx.controller.removeComputer("computer")).rejects.toThrow("只能移除离线电脑");
    const remove = vi.spyOn(fx.api, "removeComputer").mockRejectedValueOnce(new Error("Synthetic removal failed")).mockResolvedValue(undefined);
    await expect(fx.controller.removeComputer("old-computer")).rejects.toThrow("Synthetic removal failed");
    expect(fx.controller.snapshot().workspaces).toHaveLength(2);
    await fx.controller.removeComputer("old-computer");
    expect(remove).toHaveBeenCalledWith("old-computer");
    expect(fx.controller.snapshot().workspaces.map(workspace => workspace.id)).toEqual(["computer"]);
  });

  it("does not apply an old removal response to a signed-out account", async () => {
    const fx = fixture(), held = deferred<void>();
    fx.workspaces.push({ ...fx.workspace, id: "old-computer", online: false });
    await fx.login();
    vi.spyOn(fx.api, "removeComputer").mockReturnValue(held.promise);
    const removing = fx.controller.removeComputer("old-computer");
    await fx.controller.logout();
    held.resolve(); await removing;
    expect(fx.controller.snapshot().session).toBeNull();
    expect(fx.controller.snapshot().workspaces).toEqual([]);
  });

  it("opens the latest Bot reply across conversations and keeps explicit choices, drafts and sends independent", async () => {
    const fx = fixture(), original = fx.request.getMockImplementation()!;
    const tasks = [{ threadId: "thread-one", title: "原对话", updatedAt: 500 }, { threadId: "other-one", title: "新工作", updatedAt: 300, unread: true }];
    const reply = (id: string, at: number, role = "bot") => ({ id, at, role, text: id });
    const histories: Record<string, unknown[]> = { "thread-one": [reply("old-bot", 100), reply("new-user", 500, "user")], "other-one": [reply("new-bot", 300)] };
    fx.request.mockImplementation(async (path, options) => {
      if (path.startsWith("/api/bots?")) return { bots: [{ ...fx.bots[0], tasks, messages: histories["thread-one"], hasMore: false }] };
      if (path.startsWith("/api/threads/")) return { messages: histories[path.split("/")[3]], hasMore: false };
      return original(path, options);
    });
    await fx.login();
    await fx.controller.select(fx.controller.snapshot().bots[0]);
    expect(fx.controller.selectedBot()?.threadId).toBe("other-one");
    expect(fx.controller.snapshot().messages.at(-1)?.id).toBe("new-bot");
    fx.controller.setDraft("另一段的草稿");
    await fx.controller.select(fx.controller.selectedBot()!, "thread-one");
    fx.controller.setDraft("发到原对话"); await fx.controller.send();
    expect(fx.request.mock.calls.find(([, options]) => (options?.body as { text?: string })?.text)?.[1]?.body).toMatchObject({ threadId: "thread-one", text: "发到原对话" });
    expect(fx.controller.snapshot().drafts["computer/one/other-one"]).toBe("另一段的草稿");
    tasks[1].unread = true; tasks[1].updatedAt = 600; histories["other-one"] = [reply("new-bot", 300), reply("unread-bot", 600)];
    await fx.controller.refresh();
    await fx.controller.syncConversations(fx.controller.snapshot().bots);
    expect(fx.controller.selectedBot()?.threadId).toBe("thread-one");
    expect(fx.controller.conversations(fx.controller.selectedBot()!).some(item => item.threadId !== "thread-one" && item.unread)).toBe(true);
    await fx.controller.select(fx.controller.selectedBot()!, "other-one");
    expect(fx.controller.conversations(fx.controller.selectedBot()!).some(item => item.unread)).toBe(false);
    expect(fx.request.mock.calls.filter(([path]) => path.includes("/tasks"))).toEqual([]);
    fx.controller.back(); await fx.controller.select(fx.controller.snapshot().bots[0]);
    expect(fx.controller.selectedBot()?.threadId).toBe("other-one");
  });

  it("pages past internal events to locate a reply and reuses unchanged conversation summaries", async () => {
    const fx = fixture(), original = fx.request.getMockImplementation()!;
    fx.request.mockImplementation(async (path, options) => {
      if (path.startsWith("/api/bots?")) return { bots: [{ ...fx.bots[0], hasMore: false, messages: [], tasks: [{ threadId: "thread-one", updatedAt: 1 }, { threadId: "other-one", updatedAt: 5 }] }] };
      if (path.startsWith("/api/threads/other-one/")) return path.includes("before=")
        ? { messages: [{ id: "reply", role: "bot", at: 4 }], hasMore: false }
        : { messages: [{ id: "tool", role: "bot", kind: "activity", at: 5 }], hasMore: true };
      return original(path, options);
    });
    await fx.login(); await fx.controller.syncConversations(fx.controller.snapshot().bots);
    const reads = () => fx.request.mock.calls.filter(([path]) => path.startsWith("/api/threads/other-one/")).length;
    expect(reads()).toBe(2);
    expect(fx.controller.latestConversation(fx.controller.snapshot().bots[0])?.threadId).toBe("other-one");
    await fx.controller.refresh(); await fx.controller.syncConversations(fx.controller.snapshot().bots);
    expect(reads()).toBe(2);
    expect(fx.controller.conversations(fx.controller.snapshot().bots[0]).find(item => item.threadId === "other-one")?.reply?.id).toBe("reply");
  });

  it("opens the exact notification thread even when a different conversation has a later reply", async () => {
    const fx = fixture(); await fx.controller.boot(); await fx.login();
    fx.open({ accountId: "account", workspaceId: "computer", botId: "one", threadId: "other-one" });
    await vi.waitFor(() => expect(fx.controller.selectedBot()?.threadId).toBe("other-one"));
  });

  it("cancels a pending default choice on back and never applies a late summary after logout", async () => {
    const fx = fixture(), original = fx.request.getMockImplementation()!, held = deferred<unknown>();
    fx.request.mockImplementation(async (path, options) => path.startsWith("/api/threads/") ? held.promise : original(path, options));
    await fx.controller.boot(); await fx.login();
    const selecting = fx.controller.select(fx.controller.snapshot().bots[0]);
    expect(fx.controller.snapshot().openingBot).toBe("computer/one");
    fx.active(false);
    expect(fx.controller.snapshot().openingBot).toBeNull();
    fx.active(true); fx.controller.back(); await fx.controller.logout();
    held.resolve({ messages: [{ id: "late", role: "bot", at: Date.now() }], hasMore: false }); await selecting;
    expect(fx.controller.snapshot()).toMatchObject({ selected: null, openingBot: null, bots: [], conversationSync: {} });
  });

  it("continues past an inaccessible conversation and retries it without hiding other replies", async () => {
    const fx = fixture(), original = fx.request.getMockImplementation()!;
    let available = false;
    fx.request.mockImplementation(async (path, options) => {
      if (path.startsWith("/api/bots?")) return { bots: [{ ...fx.bots[0], tasks: [{ threadId: "thread-one", updatedAt: 1 }, { threadId: "other-one", updatedAt: 2 }], hasMore: false, messages: [{ id: "known", role: "bot", at: 1 }] }] };
      if (path.startsWith("/api/threads/other-one/")) {
        if (!available) throw new Error("Synthetic thread unavailable");
        return { messages: [{ id: "recovered", role: "bot", at: 2 }], hasMore: false };
      }
      return original(path, options);
    });
    await fx.login(); await fx.controller.syncConversations(fx.controller.snapshot().bots);
    expect(fx.controller.snapshot().conversationSync["computer/one"].error).toContain("部分对话尚未同步");
    expect(fx.controller.latestConversation(fx.controller.snapshot().bots[0])?.reply?.id).toBe("known");
    available = true;
    await fx.controller.syncConversations(fx.controller.snapshot().bots);
    expect(fx.controller.snapshot().conversationSync["computer/one"].error).toBe("");
    await fx.controller.select(fx.controller.snapshot().bots[0]);
    expect(fx.controller.selectedBot()?.threadId).toBe("other-one");
  });

  it("restores the latest-reply conversation from phone storage while offline", async () => {
    const fx = fixture(), original = fx.request.getMockImplementation()!;
    fx.request.mockImplementation(async (path, options) => {
      if (path.startsWith("/api/bots?")) return { bots: [{ ...fx.bots[0], hasMore: false, messages: [], tasks: [{ threadId: "thread-one", title: "旧工作", updatedAt: 1 }, { threadId: "other-one", title: "最新工作", updatedAt: 2 }] }] };
      if (path.startsWith("/api/threads/other-one/")) return { messages: [{ id: "saved-reply", role: "bot", at: 2, text: "本机缓存的最新回复" }], hasMore: false };
      return original(path, options);
    });
    await fx.login(); await fx.controller.syncConversations(fx.controller.snapshot().bots);
    fx.controller.dispose(); fx.fetcher.mockRejectedValue(new Error("Airplane mode"));
    const restarted = new MobileController(new MobileApi(fx.platform.vault), fx.platform, fx.connect); controllers.push(restarted);
    await restarted.boot(); await restarted.select(restarted.snapshot().bots[0]);
    expect(restarted.selectedBot()?.threadId).toBe("other-one");
    expect(restarted.snapshot().messages[0].text).toBe("本机缓存的最新回复");
    expect(restarted.conversations(restarted.selectedBot()!).find(item => item.threadId === "other-one")?.title).toBe("最新工作");
  });

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
        const name = ((options?.body as { path: string } | undefined)?.path ?? "/file").slice(1);
        return { data: new TextEncoder().encode(`contents:${name}`), mime: name.endsWith(".png") ? "image/png" : name.endsWith(".mp4") ? "video/mp4" : "application/pdf", name };
      }
      if (path.startsWith("/api/threads/")) return { messages: [message], hasMore: false };
      return original(path, options);
    });
    return fx;
  }
  it("preloads images and caches videos and documents when opened without refetching", async () => {
    const fx = withFiles(); await fx.login();
    const bot = fx.controller.snapshot().bots[0];
    expect(fx.controller.snapshot().selected).toBeNull();
    await vi.waitFor(async () => {
      expect(await fx.platform.cache.hasFile("account", cachedFileKey(bot, "synced", "/picture.png"))).toBe(true);
    });
    expect(fx.request.mock.calls.filter(([path]) => path.endsWith("/file"))).toHaveLength(1);
    await fx.controller.file(bot, "synced", "/movie.mp4");
    await fx.controller.file(bot, "synced", "/report.pdf");
    expect(fx.request.mock.calls.filter(([path]) => path.endsWith("/file"))).toHaveLength(3);
    await fx.controller.file(bot, "synced", "/picture.png"); await fx.controller.refresh();
    expect(fx.request.mock.calls.filter(([path]) => path.endsWith("/file"))).toHaveLength(3);
  });
  it("restores expired local identity, Bots, messages and file bytes after an offline restart", async () => {
    const fx = withFiles(); await fx.login();
    const bot = fx.controller.snapshot().bots[0];
    await fx.controller.select(bot);
    await fx.controller.file(bot, "synced", "/movie.mp4");
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
  it("keeps an external video downloading past three minutes while bytes arrive", async () => {
    const fx = fixture(); await fx.login();
    vi.useFakeTimers();
    let stream!: ReadableStreamDefaultController<Uint8Array>, signal!: AbortSignal;
    fx.fetcher.mockImplementationOnce(async (_url, options) => {
      signal = options!.signal!;
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        stream = controller;
        signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      } }), { headers: { "content-type": "video/mp4" } });
    });
    const reading = fx.controller.file(fx.controller.snapshot().bots[0], "video", "https://media.example.test/long.mp4");
    await vi.waitFor(() => expect(stream).toBeDefined());
    for (let chunk = 0; chunk < 5; chunk++) {
      await vi.advanceTimersByTimeAsync(60_000);
      stream.enqueue(new Uint8Array([chunk]));
      await vi.advanceTimersByTimeAsync(0);
      expect(signal.aborted).toBe(false);
    }
    stream.close(); vi.useRealTimers();
    expect(await reading).toMatchObject({ mime: "video/mp4", data: new Uint8Array([0, 1, 2, 3, 4]) });
    expect(fx.controller.snapshot().session?.account.id).toBe("account");
  });
  it("automatically retries a stalled external download without signing out or closing the workspace", async () => {
    const fx = fixture(); await fx.login();
    vi.useFakeTimers();
    let signal!: AbortSignal;
    fx.fetcher.mockImplementationOnce(async (_url, options) => {
      signal = options!.signal!;
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      } }));
    });
    fx.fetcher.mockImplementationOnce(async () => new Response(new Uint8Array([3, 4]), { headers: { "content-type": "video/mp4" } }));
    const result = fx.controller.file(fx.controller.snapshot().bots[0], "video", "https://media.example.test/stalled.mp4");
    await vi.waitFor(() => expect(signal).toBeDefined());
    await vi.advanceTimersByTimeAsync(180_001);
    expect(signal.aborted).toBe(true);
    expect(Object.values(fx.controller.snapshot().fileTransfers).some(value => value.phase === "reconnecting")).toBe(true);
    await vi.advanceTimersByTimeAsync(1000); vi.useRealTimers();
    expect((await result).data).toEqual(new Uint8Array([3, 4]));
    expect(fx.controller.snapshot().session?.account.id).toBe("account");
    expect(fx.connection.close).not.toHaveBeenCalled();
    vi.useRealTimers(); await fx.controller.refresh();
    expect(fx.controller.snapshot().bots).toHaveLength(2);
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
  it("uploads a document once and preserves the message identity after uncertain delivery", async () => {
    const fx = fixture(); await fx.login(); await fx.controller.select(fx.controller.snapshot().bots[0]);
    const name = '工作&"说明.pdf', blob = new Blob(["%PDF-1.4\nfixture"], { type: "" });
    fx.platform.media.pickDocuments = async () => [{ name, blob }];
    await fx.controller.pickDocuments();
    const original = fx.request.getMockImplementation()!;
    let delivered = false;
    fx.request.mockImplementation(async (path, options) => {
      if (path.startsWith("/api/files?")) return { path: "/private/note.pdf", mime: "application/pdf", bytes: blob.size };
      if (path.endsWith("/messages") && options?.method === "POST") {
        if (!delivered) throw new Error("Synthetic lost acknowledgement");
        return { ok: true };
      }
      return original(path, options);
    });
    await fx.controller.send(); delivered = true; await fx.controller.send();
    const uploads = fx.request.mock.calls.filter(([path]) => path.startsWith("/api/files?"));
    expect(uploads).toHaveLength(1);
    expect(new URL(uploads[0][0], "https://fixture.test").searchParams.get("name")).toBe(name);
    const upload = uploads[0][1] as { rawBody: Uint8Array; contentType: string };
    expect(upload.contentType).toBe("application/pdf"); expect(upload.rawBody.length).toBe(blob.size);
    const sends = fx.request.mock.calls.filter(([, options]) => (options?.body as { sendId?: string })?.sendId);
    expect(sends).toHaveLength(2); expect(sends[0][1]?.body).toEqual(sends[1][1]?.body);
    expect(sends[0][1]?.body).toMatchObject({ text: '<attached-file path="/private/note.pdf" name="工作&amp;&quot;说明.pdf" />', threadId: "thread-one" });
  });
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

it("retains a healthy transport after a single request error and reconnects a closed transport", async () => {
  const fx = fixture(); await fx.login();
  const original = fx.request.getMockImplementation()!;
  fx.request.mockRejectedValueOnce(new Error("Synthetic JSON timeout"));
  await fx.controller.refresh();
  expect(fx.connection.close).not.toHaveBeenCalled();
  expect(fx.controller.snapshot().bots[0].workspace.online).toBe(true);
  fx.request.mockImplementation(original);
  Object.defineProperty(fx.connection, "closed", { value: true });
  const replacement: WorkspaceConnection = { request: fx.request as WorkspaceConnection["request"], close: vi.fn() };
  fx.connect.mockResolvedValueOnce(replacement);
  await fx.controller.refresh();
  expect(fx.connect).toHaveBeenCalledTimes(2);
  expect(fx.connection.close).toHaveBeenCalledOnce();
  expect(fx.controller.snapshot().bots[0].workspace.online).toBe(true);
});

describe("departments and group conversations", () => {
  it("counts all unread messages across paged tasks and groups without marking them read, and persists totals", async () => {
    const fx = fixture(), original = fx.request.getMockImplementation()!;
    const messages = Array.from({ length: 75 }, (_, i) => ({ id: `m-${i}`, role: "bot", text: `${i}` }));
    let marker = "m-4";
    fx.request.mockImplementation(async (path, options) => {
      if (path.startsWith("/api/bots?")) return { bots: [{ ...fx.bots[0], section: "Studio", unread: true, messages: messages.slice(-20), hasMore: true,
        tasks: [{ threadId: "thread-one", unread: true, lastReadMessageId: marker, updatedAt: messages.length }, { threadId: "other-one", unread: true, updatedAt: 1 }] }],
        groups: [{ id: "room", name: "Room", threadId: "room-thread", memberIds: ["one"], section: "Studio", unread: true, lastReadMessageId: "read", messages: [{ id: "read", role: "bot" }, { id: "new", role: "bot" }], hasMore: false }] };
      if (path.startsWith("/api/threads/thread-one/messages")) {
        const url = new URL(path, "http://fixture.invalid"), before = url.searchParams.get("before");
        const end = before ? messages.findIndex(message => message.id === before) : messages.length;
        return { messages: messages.slice(Math.max(0, end - 50), end), hasMore: end > 50 };
      }
      if (path.startsWith("/api/threads/other-one/")) return { messages: [{ id: "other-reply", role: "bot" }, { id: "other-user", role: "user" }], hasMore: false };
      return original(path, options);
    });
    await fx.login();
    await vi.waitFor(() => expect(fx.controller.snapshot().bots.map(bot => bot.unreadCount)).toEqual([71, 1]));
    expect(fx.request.mock.calls.some(([path]) => path.endsWith("/read"))).toBe(false);
    expect(fx.request).toHaveBeenCalledWith("/api/threads/thread-one/messages?limit=50&before=m-55");
    expect(fx.request).toHaveBeenCalledWith("/api/threads/thread-one/messages?limit=50&before=m-5");
    await vi.waitFor(async () => {
      const saved = JSON.parse((await fx.platform.cache.readState("account"))!);
      expect(saved.bots.map((bot: { unreadCount: number }) => bot.unreadCount)).toEqual([71, 1]);
      expect(saved.conversations.find(([key]: [string]) => key === "computer/one/thread-one")[1].messages).toHaveLength(75);
    });
    fx.request.mockClear(); await fx.controller.refresh();
    expect(fx.request.mock.calls.filter(([path]) => path.startsWith("/api/threads/"))).toHaveLength(0);
    marker = "m-73"; await fx.controller.refresh();
    await vi.waitFor(() => expect(fx.controller.snapshot().bots[0].unreadCount).toBe(2));
    await fx.controller.select(fx.controller.snapshot().bots[0]);
    expect(fx.controller.snapshot().bots[0].unread).toBe(true);
    expect(fx.controller.snapshot().bots[0].tasks.find(task => task.threadId === "other-one")?.unread).toBe(true);
  });

  it("ignores a late unread count after the conversation is read or the account logs out", async () => {
    const fx = fixture(), original = fx.request.getMockImplementation()!, held = deferred<unknown>();
    fx.request.mockImplementation(async (path, options) => {
      if (path.startsWith("/api/bots?")) return { bots: [{ ...fx.bots[0], unread: true }] };
      if (path.startsWith("/api/threads/")) return held.promise;
      return original(path, options);
    });
    await fx.login();
    await vi.waitFor(() => expect(fx.request.mock.calls.some(([path]) => path.startsWith("/api/threads/"))).toBe(true));
    const selecting = fx.controller.select(fx.controller.snapshot().bots[0], "thread-one");
    held.resolve({ messages: [{ id: "reply", role: "bot" }], hasMore: false }); await selecting;
    expect(fx.controller.snapshot().bots[0]).toMatchObject({ unread: false, unreadCount: 0 });
    fx.controller.back();
    const afterLogout = deferred<unknown>();
    fx.request.mockImplementation(async (path, options) => {
      if (path.startsWith("/api/bots?")) return { bots: [{ ...fx.bots[0], unread: true, messages: [{ id: "new-reply", role: "bot" }] }] };
      if (path.startsWith("/api/threads/")) return afterLogout.promise;
      return original(path, options);
    });
    await fx.controller.refresh(); await fx.controller.logout();
    afterLogout.resolve({ messages: [{ id: "new-reply", role: "bot" }], hasMore: false });
    await Promise.resolve();
    expect(fx.controller.snapshot().bots).toEqual([]);
    expect(await fx.platform.cache.readState("account")).toBeNull();
  });

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

describe("automatic status refresh and app lifecycle", () => {
  it("refreshes a restored session even while phone presence is stalled", async () => {
    const fx = fixture(); await fx.login();
    const presence = deferred<Response>();
    const original = fx.fetcher.getMockImplementation()!;
    fx.fetcher.mockImplementation((url, options) => url.endsWith("/mobile/session") ? presence.promise : original(url, options));
    const restarted = new MobileController(new MobileApi(fx.platform.vault), fx.platform, fx.connect); controllers.push(restarted);
    const boot = restarted.boot();
    await vi.waitFor(() => expect(restarted.snapshot().bots[0]?.workspace.online).toBe(true));
    expect(restarted.snapshot().phase).toBe("ready");
    presence.resolve(Response.json({ ok: true })); await boot;
  });

  it("updates gateway status before a slow Bot request completes and ignores its late reply", async () => {
    const fx = fixture(); await fx.login();
    const held = deferred<unknown>();
    fx.request.mockReturnValueOnce(held.promise);
    const slow = fx.controller.refresh();
    await vi.waitFor(() => expect(fx.request.mock.calls.filter(([path]) => path.startsWith("/api/bots?"))).toHaveLength(2));
    fx.workspace.online = false;
    await fx.controller.refresh("computer");
    expect(fx.controller.snapshot().workspaces[0].online).toBe(false);
    expect(fx.controller.snapshot().bots[0].workspace.online).toBe(false);
    held.resolve({ bots: [{ ...fx.bots[0], name: "Late stale bot" }] }); await slow;
    expect(fx.controller.snapshot().bots.map(bot => bot.name)).not.toContain("Late stale bot");
  });

  it("refreshes Cloud while another workspace request is stalled", async () => {
    const fx = fixture(); await fx.login();
    fx.workspaces.push({ ...fx.workspace, id: "cloud", kind: "cloud" });
    const held = deferred<unknown>();
    fx.request.mockReturnValueOnce(held.promise);
    const slow = fx.controller.refresh("computer");
    await vi.waitFor(() => expect(fx.request.mock.calls.filter(([path]) => path.startsWith("/api/bots?"))).toHaveLength(2));
    await fx.controller.refresh("cloud");
    expect(fx.controller.snapshot().bots.filter(bot => bot.workspace.id === "cloud")).toHaveLength(2);
    expect(fx.controller.snapshot().sourceErrors.cloud).toBeUndefined();
    held.resolve({ bots: fx.bots }); await slow;
  });

  it("stops polling in the background, keeps push, and reconnects with current messages on return", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const fx = fixture(); await fx.controller.boot(); await fx.login(); await fx.controller.enablePush();
    await fx.controller.select(fx.controller.snapshot().bots[0]);
    fx.fetcher.mockClear();
    fx.active(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fx.fetcher).not.toHaveBeenCalled();
    expect(fx.platform.push.unregister).not.toHaveBeenCalled();
    expect(fx.values.get("donebot.push.account")).toBe("on");
    const previousConnects = fx.connect.mock.calls.length;
    const original = fx.request.getMockImplementation()!;
    fx.request.mockImplementation(async (path, options) => path.startsWith("/api/threads/") ? { messages: [{ id: "after-resume", role: "bot", text: "While you were away" }] } : original(path, options));
    fx.active(true);
    await vi.waitFor(() => expect(fx.controller.snapshot().messages[0]?.id).toBe("after-resume"));
    expect(fx.connect.mock.calls.length).toBeGreaterThan(previousConnects);
    expect(fx.fetcher.mock.calls.some(([url]) => url.endsWith("/mobile/workspaces"))).toBe(true);
    await vi.waitFor(() => expect(fx.controller.snapshot().push).toBe("on"));
    expect(fx.platform.push.register).toHaveBeenCalledTimes(2);
  });

  it("replaces a request suspended before backgrounding without accepting its late result", async () => {
    const fx = fixture(); await fx.controller.boot(); await fx.login();
    const held = deferred<unknown>(); fx.request.mockReturnValueOnce(held.promise);
    const stale = fx.controller.refresh();
    await vi.waitFor(() => expect(fx.request.mock.calls.filter(([path]) => path.startsWith("/api/bots?"))).toHaveLength(2));
    fx.active(false); fx.bots[0].name = "Fresh bot"; fx.active(true);
    await vi.waitFor(() => expect(fx.controller.snapshot().bots[0]?.name).toBe("Fresh bot"));
    held.resolve({ bots: [{ ...fx.bots[0], name: "Suspended stale bot" }] }); await stale;
    expect(fx.controller.snapshot().bots[0]?.name).toBe("Fresh bot");
  });

  it("retries a consented failed subscription when networking returns without a new prompt", async () => {
    const fx = fixture(); vi.stubGlobal("window", new EventTarget());
    await fx.controller.boot(); await fx.login();
    const subscribe = vi.spyOn(fx.api, "subscribe").mockRejectedValueOnce(new Error("Synthetic network failure"));
    await fx.controller.enablePush();
    expect(fx.controller.snapshot().push).toBe("off");
    expect(fx.values.get("donebot.push.account")).toBe("on");
    window.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(fx.controller.snapshot().push).toBe("on"));
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  it("notices revoked system notification permission on return without re-enabling it", async () => {
    const fx = fixture(); await fx.controller.boot(); await fx.login(); await fx.controller.enablePush();
    vi.mocked(fx.platform.push.permission).mockResolvedValue("denied");
    fx.active(false); fx.active(true);
    await vi.waitFor(() => expect(fx.controller.snapshot().pushError).toContain("系统设置"));
    expect(fx.controller.snapshot().push).toBe("off");
    expect(fx.platform.push.register).toHaveBeenCalledTimes(1);
  });
});

it("waits before retrying a failed push subscription while the app stays active", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const fx = fixture(); await fx.controller.boot(); await fx.login();
  const subscribe = vi.spyOn(fx.api, "subscribe").mockRejectedValueOnce(new Error("Synthetic outage"));
  await fx.controller.enablePush();
  await vi.advanceTimersByTimeAsync(56_000);
  expect(subscribe).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(4_000);
  await vi.waitFor(() => expect(fx.controller.snapshot().push).toBe("on"));
  expect(subscribe).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(subscribe).toHaveBeenCalledTimes(2);
});

it("does not start a message poll when a foreground refresh settles in the background", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const fx = fixture(); await fx.controller.boot(); await fx.login(); await fx.controller.select(fx.controller.snapshot().bots[0]);
  const held = deferred<unknown>(); fx.request.mockReturnValueOnce(held.promise);
  await vi.advanceTimersByTimeAsync(4_000);
  const calls = fx.request.mock.calls.length;
  fx.active(false); held.resolve({ bots: fx.bots });
  await vi.advanceTimersByTimeAsync(8_000);
  expect(fx.request).toHaveBeenCalledTimes(calls);
});

it("does not close a recovered connection when a pre-background history request fails late", async () => {
  const fx = fixture(); await fx.controller.boot(); await fx.login();
  const held = deferred<unknown>(); fx.request.mockReturnValueOnce(held.promise);
  const selecting = fx.controller.select(fx.controller.snapshot().bots[0], "thread-one");
  await vi.waitFor(() => expect(fx.request.mock.calls.some(([path]) => path.startsWith("/api/threads/thread-one/"))).toBe(true));
  fx.active(false); fx.active(true);
  await vi.waitFor(() => expect(fx.connect).toHaveBeenCalledTimes(2));
  held.reject(new Error("Suspended request closed")); await selecting;
  await fx.controller.pollMessages();
  expect(fx.connect).toHaveBeenCalledTimes(2);
});

it("keeps both computer and Cloud online when their Bots carry desktop expression names", async () => {
  const fx = fixture();
  Object.assign(fx.bots[0], { mascotExpression: "proud" });
  Object.assign(fx.bots[1], { mascotExpression: "happy" });
  fx.workspaces.push({ ...fx.workspace, id: "cloud", kind: "cloud" });
  await fx.login();
  const snapshot = fx.controller.snapshot();
  expect(snapshot.sourceErrors).toEqual({});
  expect(snapshot.bots).toHaveLength(4);
  expect(snapshot.bots.every(bot => bot.workspace.online)).toBe(true);
  expect(snapshot.bots.map(bot => bot.mascotExpression)).toEqual(["proud", "happy", "proud", "happy"]);
});

it.each(["computer", "cloud"].flatMap(kind => ["image/png", "video/mp4", "audio/mpeg", "application/pdf"].map(mime => ({ kind, mime }))))("reconnects and resumes $mime from $kind without resetting other streams", async ({ kind, mime }) => {
  const fx = fixture(), original = fx.request.getMockImplementation()!;
  fx.workspace.kind = kind;
  let closed = false, interrupted = false;
  Object.defineProperty(fx.connection, "closed", { get: () => closed });
  fx.connect.mockImplementation(async () => { closed = false; return fx.connection; });
  const source = new Uint8Array(FILE_SEGMENT_BYTES + 71).fill(113), offsets: number[] = [];
  fx.request.mockImplementation(async (path, options) => {
    if (options?.responseType !== "bytes") return original(path, options);
    const start = options.range!.start, end = Math.min(options.range!.end, source.length - 1);
    offsets.push(start);
    if (start && !interrupted) { interrupted = true; closed = true; throw new TransferError("socket closed", true); }
    return { data: source.slice(start, end + 1), mime, name: "asset", range: { start, end, total: source.length, etag: '"fixture-version"' } };
  });
  await fx.login();
  const result = await fx.controller.file(fx.controller.snapshot().bots[0], "media", "/asset");
  expect(result).toEqual({ data: source, mime, name: "asset" });
  expect(offsets).toEqual([0, FILE_SEGMENT_BYTES, FILE_SEGMENT_BYTES, 0]);
  expect(fx.connect).toHaveBeenCalledTimes(2);
  await fx.controller.refresh();
  expect(fx.controller.snapshot().sourceErrors).toEqual({});
});

it("pauses an interrupted download in background and resumes its checkpoint in foreground", async () => {
  const fx = fixture(), original = fx.request.getMockImplementation()!;
  await fx.controller.boot();
  const source = new Uint8Array(FILE_SEGMENT_BYTES + 17).fill(77), offsets: number[] = [];
  let interrupted = false;
  fx.request.mockImplementation(async (path, options) => {
    if (options?.responseType !== "bytes") return original(path, options);
    const start = options.range!.start, end = Math.min(options.range!.end, source.length - 1);
    offsets.push(start);
    if (start && !interrupted) { interrupted = true; fx.active(false); throw new TransferError("background", true); }
    return { data: source.slice(start, end + 1), mime: "video/mp4", name: "video", range: { start, end, total: source.length, etag: '"version"' } };
  });
  await fx.login();
  const result = fx.controller.file(fx.controller.snapshot().bots[0], "video", "/video");
  await vi.waitFor(() => expect(Object.values(fx.controller.snapshot().fileTransfers).some(value => value.phase === "paused")).toBe(true), { timeout: 2500 });
  expect(offsets).toEqual([0, FILE_SEGMENT_BYTES]);
  fx.active(true);
  expect((await result).data).toEqual(source);
  expect(offsets).toEqual([0, FILE_SEGMENT_BYTES, FILE_SEGMENT_BYTES, 0]);
});
