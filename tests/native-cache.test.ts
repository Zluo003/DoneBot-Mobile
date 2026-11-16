import { Buffer } from "buffer";
import { expect, it, vi } from "vitest";
import { nativeOfflineStorage } from "../src/platform/cache";
import type { FileCheckpoint } from "../src/core/contracts";

const { files, failManifest } = vi.hoisted(() => ({ files: new Map<string, string>(), failManifest: { value: false } }));
vi.mock("@capacitor/filesystem", () => ({
  Directory: { LibraryNoCloud: "library" }, Encoding: { UTF8: "utf8" },
  Filesystem: {
    readFile: async ({ path }: { path: string }) => { if (!files.has(path)) throw new Error("ENOENT"); return { data: files.get(path) }; },
    writeFile: async ({ path, data }: { path: string; data: string }) => { if (path.endsWith("manifest.json") && failManifest.value) throw new Error("disk interrupted"); files.set(path, data); },
    rmdir: async ({ path }: { path: string }) => { for (const name of files.keys()) if (name.startsWith(`${path}/`)) files.delete(name); },
  },
}));

it("commits native chunks before their manifest and recovers the last complete checkpoint after a disk interruption", async () => {
  const data = new Uint8Array(1024 * 1024).fill(41);
  const first: FileCheckpoint = { etag: '"version"', total: data.length * 2, received: data.length, parts: 1, mime: "video/mp4", name: "film.mp4" };
  await nativeOfflineStorage.appendPartial("account", "video", first, data);
  expect((await nativeOfflineStorage.readPartial("account", "video"))?.chunks[0]).toEqual(data);
  failManifest.value = true;
  await expect(nativeOfflineStorage.appendPartial("account", "video", { ...first, received: data.length * 2, parts: 2 }, data)).rejects.toThrow("disk interrupted");
  failManifest.value = false;
  expect((await nativeOfflineStorage.readPartial("account", "video"))?.checkpoint).toEqual(first);
  expect(await nativeOfflineStorage.readPartial("another-account", "video")).toBeNull();
  await nativeOfflineStorage.clearPartial("account", "video");
  expect(await nativeOfflineStorage.readPartial("account", "video")).toBeNull();
  expect([...files.values()].some(value => value === Buffer.from(data).toString("base64"))).toBe(false);
});
