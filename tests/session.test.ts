import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileApi } from "../src/core/api";
import { messageSchema, visibleWorkspaces } from "../src/core/contracts";

function vault() {
  const values = new Map<string, string>();
  return { values, read: async (key: string) => values.get(key) ?? null, write: async (key: string, value: string) => { values.set(key, value); }, remove: async (key: string) => { values.delete(key); } };
}
const login = { access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_in: 3600, user: { id: 1, email: "one@fixture.test" } };
afterEach(() => vi.unstubAllGlobals());

describe("account isolation", () => {
  it("removes the mobile workspace registration without revoking the computer login", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ code: 0, data: login })).mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    const api = new MobileApi(vault());
    await api.login("one@fixture.test", "synthetic");
    await api.removeComputer("offline-computer");
    expect(fetcher.mock.calls[1][0]).toBe("https://donebot.cn/api/v1/donebot/mobile/workspaces/offline-computer");
    expect(fetcher.mock.calls[1][1]).toMatchObject({ method: "DELETE", headers: { authorization: "Bearer synthetic-access" } });
    expect(api.current()?.account.id).toBe("1");
  });
  it("explains when a computer reconnects before removal reaches the gateway", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ code: 0, data: login })).mockResolvedValueOnce(Response.json({ reason: "MOBILE_COMPUTER_ONLINE" }, { status: 409 })));
    const api = new MobileApi(vault());
    await api.login("one@fixture.test", "synthetic");
    await expect(api.removeComputer("computer")).rejects.toThrow("已恢复在线");
  });
  it("uses one installation when workspace connections start concurrently", async () => {
    const storage = vault(); const api = new MobileApi(storage);
    const ids = await Promise.all([api.installationId(), api.installationId(), api.installationId()]);
    expect(new Set(ids).size).toBe(1);
    expect(storage.values.size).toBe(1);
  });
  it("discards a login result after logout", async () => {
    let resolve!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(done => { resolve = done; })));
    const storage = vault(); const api = new MobileApi(storage);
    const pending = api.login("one@fixture.test", "synthetic");
    await api.logout();
    resolve(Response.json({ code: 0, data: login }));
    await expect(pending).rejects.toThrow("取消");
    expect(api.current()).toBeNull(); expect(storage.values.size).toBe(0);
  });
  it("does not persist passwords, and clears the session on logout", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: 0, data: login })));
    const storage = vault(); const api = new MobileApi(storage);
    await api.login("one@fixture.test", "secret-password");
    expect([...storage.values.values()].join()).not.toContain("secret-password");
    expect(api.current()?.account.id).toBe("1");
    await api.logout(); expect(api.current()).toBeNull(); expect(storage.values.size).toBe(0);
  });
  it("uses the existing two factor endpoint", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ code: 0, data: { requires_2fa: true, temp_token: "synthetic-challenge" } })).mockResolvedValueOnce(Response.json({ code: 0, data: login }));
    vi.stubGlobal("fetch", fetcher);
    const api = new MobileApi(vault());
    expect(await api.login("one@fixture.test", "synthetic")).toEqual({ challenge: "synthetic-challenge" });
    expect(api.current()).toBeNull();
    await api.verify("synthetic-challenge", "123456");
    expect(fetcher.mock.calls[1][0]).toBe("https://donebot.cn/api/v1/auth/login/2fa");
  });
  it("hides unprovisioned Cloud while keeping offline computers and provisioned Cloud", () => {
    expect(visibleWorkspaces([
      { id: "one", name: "offline", kind: "computer", online: false, provisioned: false },
      { id: "two", name: "expired", kind: "cloud", online: false, provisioned: true },
      { id: "three", name: "never-created", kind: "cloud", online: false, provisioned: false },
    ]).map(workspace => workspace.id)).toEqual(["one", "two"]);
  });
  it("reads the original desktop message timestamp", () => {
    expect(messageSchema.parse({ id: "message", role: "bot", text: "fixture", at: 1794656725196 }).timestamp).toBe(1794656725196);
  });
});
