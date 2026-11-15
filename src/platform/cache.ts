import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { Buffer } from "buffer";
import type { BinaryFile, OfflineStorage } from "../core/contracts";

const directory = Directory.LibraryNoCloud;
const missing = (error: unknown) => /not (?:exist|found)|doesn't exist|can't find (?:file|directory)|ENOENT/i.test(String((error as Error)?.message ?? error));
async function hash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
const accountRoot = async (account: string) => `donebot-offline-v1/${await hash(account)}`;
const fileRoot = async (account: string, key: string) => `${await accountRoot(account)}/files/${await hash(key)}`;
async function readText(path: string): Promise<string | null> {
  try { return (await Filesystem.readFile({ directory, path, encoding: Encoding.UTF8 })).data as string; }
  catch (error) { if (missing(error)) return null; throw error; }
}
async function metadata(account: string, key: string) {
  const root = await fileRoot(account, key), raw = await readText(`${root}/metadata.json`);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { mime: string; name: string; size: number };
    if (typeof value.mime !== "string" || typeof value.name !== "string" || !Number.isSafeInteger(value.size) || value.size < 0) return null;
    if ((await Filesystem.stat({ directory, path: `${root}/data` })).size !== value.size) return null;
    return { root, ...value };
  } catch { return null; }
}

export const nativeOfflineStorage: OfflineStorage = {
  async readState(account) {
    const root = await accountRoot(account);
    for (const name of ["state.json", "state.previous.json"]) {
      const raw = await readText(`${root}/${name}`);
      if (raw) { try { JSON.parse(raw); return raw; } catch { } }
    }
    return null;
  },
  async writeState(account, value) {
    const root = await accountRoot(account), previous = await this.readState(account);
    if (previous) await Filesystem.writeFile({ directory, path: `${root}/state.previous.json`, data: previous, encoding: Encoding.UTF8, recursive: true });
    await Filesystem.writeFile({ directory, path: `${root}/state.json`, data: value, encoding: Encoding.UTF8, recursive: true });
  },
  async hasFile(account, key) { return Boolean(await metadata(account, key)); },
  async readFile(account, key) {
    const meta = await metadata(account, key);
    if (!meta) return null;
    try {
      const { data } = await Filesystem.readFile({ directory, path: `${meta.root}/data` });
      const bytes = typeof data === "string" ? new Uint8Array(Buffer.from(data, "base64")) : new Uint8Array(await data.arrayBuffer());
      return bytes.length === meta.size ? { data: bytes, mime: meta.mime, name: meta.name } : null;
    } catch (error) { if (missing(error)) return null; throw error; }
  },
  async writeFile(account, key, file) {
    const root = await fileRoot(account, key), chunkSize = 384 * 1024;
    for (let offset = 0; offset < Math.max(1, file.data.length); offset += chunkSize) {
      const data = Buffer.from(file.data.subarray(offset, offset + chunkSize)).toString("base64");
      if (!offset) await Filesystem.writeFile({ directory, path: `${root}/data`, data, recursive: true });
      else await Filesystem.appendFile({ directory, path: `${root}/data`, data });
    }
    // Commit the manifest only after every byte is on disk; partial transfers are never cache hits.
    await Filesystem.writeFile({ directory, path: `${root}/metadata.json`, data: JSON.stringify({ mime: file.mime, name: file.name, size: file.data.length }), encoding: Encoding.UTF8 });
  },
  async clear(account) {
    try { await Filesystem.rmdir({ directory, path: await accountRoot(account), recursive: true }); }
    catch (error) { if (!missing(error)) throw error; }
  },
};

export function indexedDBStorage(name = "donebot-offline-v1"): OfflineStorage {
  let database: Promise<IDBDatabase> | undefined;
  const open = () => database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("entries");
    request.onsuccess = () => {
      const db = request.result;
      db.onclose = () => { database = undefined; };
      db.onversionchange = () => { db.close(); database = undefined; };
      resolve(db);
    };
    request.onerror = () => { database = undefined; reject(request.error); };
  });
  const operation = async <T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("entries", mode), request = action(tx.objectStore("entries"));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(tx.error ?? request.error ?? new Error("离线存储不可用。"));
    });
  };
  return {
    async readState(account) { return await operation("readonly", store => store.get([account, "state"])) ?? null; },
    async writeState(account, value) { await operation("readwrite", store => store.put(value, [account, "state"])); },
    async hasFile(account, key) { return Boolean(await operation("readonly", store => store.count([account, `file:${key}`]))); },
    async readFile(account, key) { return await operation<BinaryFile | undefined>("readonly", store => store.get([account, `file:${key}`])) ?? null; },
    async writeFile(account, key, file) { await operation("readwrite", store => store.put(file, [account, `file:${key}`])); },
    async clear(account) { await operation("readwrite", store => store.delete(IDBKeyRange.bound([account], [account, "\uffff"]))); },
  };
}
export const webOfflineStorage = indexedDBStorage();
