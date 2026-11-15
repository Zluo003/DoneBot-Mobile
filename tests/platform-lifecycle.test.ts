import { afterEach, beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  listen: vi.fn(), state: vi.fn(), remove: vi.fn(async () => {}),
}));
vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => "ios" }, registerPlugin: () => ({}) }));
vi.mock("@capacitor/app", () => ({ App: { addListener: native.listen, getState: native.state } }));
vi.mock("@capacitor/push-notifications", () => ({ PushNotifications: {} }));
vi.mock("../src/platform/media", () => ({ nativeMedia: {}, webMedia: {} }));
vi.mock("../src/platform/cache", () => ({ nativeOfflineStorage: {}, webOfflineStorage: {} }));
import { platform } from "../src/platform";

let active: (state: { isActive: boolean }) => void;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("document", Object.assign(new EventTarget(), { hidden: false }));
  native.listen.mockImplementation(async (_name, listener) => { active = listener; return { remove: native.remove }; });
  native.state.mockResolvedValue({ isActive: true });
});
afterEach(() => vi.unstubAllGlobals());

it("uses native lifecycle state while treating hidden web content as inactive", async () => {
  const states: boolean[] = [];
  const remove = await platform().onActiveChange(value => states.push(value));
  active({ isActive: false });
  document.dispatchEvent(new Event("visibilitychange"));
  expect(states.at(-1)).toBe(false);
  active({ isActive: true });
  Object.defineProperty(document, "hidden", { value: true, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
  expect(states).toEqual([true, false, false, true, false]);
  remove();
  Object.defineProperty(document, "hidden", { value: false }); document.dispatchEvent(new Event("visibilitychange"));
  expect(states.at(-1)).toBe(false);
  expect(native.remove).toHaveBeenCalledOnce();
});

it("does not let a late initial snapshot overwrite a new background event", async () => {
  let resolve!: (state: { isActive: boolean }) => void;
  native.state.mockReturnValue(new Promise(done => { resolve = done; }));
  const states: boolean[] = [];
  const installing = platform().onActiveChange(value => states.push(value));
  await vi.waitFor(() => expect(native.state).toHaveBeenCalledOnce());
  active({ isActive: false }); resolve({ isActive: true });
  const remove = await installing;
  expect(states).toEqual([false]); remove();
});
