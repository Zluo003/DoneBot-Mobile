import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const desktop = resolve(root, "../DoneBot");
const upstream = "// Copyright OpenMausBot contributors. Apache-2.0; see third_party/OpenMausBot-LICENSE.\n";
await mkdir(resolve(root, "src/desktop"), { recursive: true });
await mkdir(resolve(root, "third_party"), { recursive: true });
await mkdir(resolve(root, "public/brand"), { recursive: true });
await copyFile(resolve(desktop, "LICENSE"), resolve(root, "third_party/OpenMausBot-LICENSE"));
await copyFile(resolve(desktop, "branding/donebot/donebot-mark-black.svg"), resolve(root, "public/brand/mark.svg"));
await copyFile(resolve(desktop, "public/app-icon-192.png"), resolve(root, "public/brand/app-icon.png"));
const css = await readFile(resolve(desktop, "src/styles.css"), "utf8");
const skins = ["daylight", "midnight"].map(skin => {
  const block = css.match(new RegExp(`\\[data-skin="${skin}"\\] \\{([\\s\\S]*?)\\n\\}`))?.[1];
  if (!block) throw new Error(`Missing desktop skin ${skin}`);
  return `[data-skin="${skin}"] {${block.replace(/\/\*[\s\S]*?\*\//g, "")}\n}`;
});
await writeFile(resolve(root, "src/desktop/tokens.css"), "/* Copyright OpenMausBot contributors. Apache-2.0. */\n" + skins.join("\n"));

let noise = await readFile(resolve(desktop, "companion/src/e2e/noise.ts"), "utf8");
noise = noise.replace(/^import .*from "node:crypto";$/m, `import { Buffer } from "buffer";\nimport { p256 } from "@noble/curves/nist.js";\nimport { hkdf as nobleHkdf } from "@noble/hashes/hkdf.js";\nimport { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";\nimport { gcm } from "@noble/ciphers/aes.js";\nconst randomBytes = (size: number): Buffer => Buffer.from(crypto.getRandomValues(new Uint8Array(size)));`);
noise = noise.replace(/const ecdh = [\s\S]*?\/\*\* Throws for/, "/** Throws for");
noise = noise.replace('ecdh(privateKey).getPublicKey(null, "uncompressed")', "Buffer.from(p256.getPublicKey(privateKey, false))");
noise = noise.replace(/export function generateKeyPair\(\): KeyPair \{[\s\S]*?\n\}/, "export function generateKeyPair(): KeyPair { return keyPairFromPrivate(p256.utils.randomSecretKey()); }");
noise = noise.replace("ecdh(privateKey).computeSecret(publicKey)", "Buffer.from(p256.getSharedSecret(privateKey, publicKey, false).subarray(1, 33))");
noise = noise.replace('hkdfSync("sha256", ikm, chainingKey, Buffer.alloc(0), 32 * outputs)', "nobleHkdf(nobleSha256, ikm, chainingKey, undefined, 32 * outputs)");
noise = noise.replace(/export function aeadSeal\([\s\S]*?\n\}\n\nexport function aeadOpen\([\s\S]*?\n\}/, `export function aeadSeal(key: Uint8Array, n: number, ad: Uint8Array, plaintext: Uint8Array): Buffer {\n  return Buffer.from(gcm(key, nonceBytes(n), ad).encrypt(plaintext));\n}\nexport function aeadOpen(key: Uint8Array, n: number, ad: Uint8Array, ciphertext: Uint8Array): Buffer {\n  if (ciphertext.length < TAG_BYTES) throw new NoiseError("short_ciphertext");\n  try { return Buffer.from(gcm(key, nonceBytes(n), ad).decrypt(ciphertext)); }\n  catch { throw new NoiseError("aead"); }\n}`);
await writeFile(resolve(root, "src/desktop/noise.ts"), upstream + noise);
const mux = await readFile(resolve(desktop, "companion/src/e2e/yamux.ts"), "utf8");
await writeFile(resolve(root, "src/desktop/yamux.ts"), upstream + 'import { Buffer } from "buffer";\n' + mux);
const credentials = await readFile(resolve(desktop, "companion/src/e2e/credentials.ts"), "utf8");
let browserCredentials = credentials.slice(credentials.indexOf("const B64U"), credentials.indexOf("export const RELAY_TOKEN_TTL_S"));
browserCredentials = browserCredentials.replace('createHash("sha256").update(bytes).digest()', 'Buffer.from(hash(typeof bytes === "string" ? Buffer.from(bytes) : bytes))');
browserCredentials = browserCredentials.replace('createHmac("sha256", key).update(message).digest()', "Buffer.from(hmac(hash, key, message))");
browserCredentials = browserCredentials.replace("timingSafeEqual(a, b)", "equalBytes(a, b)");
browserCredentials = browserCredentials.replace('Buffer.from(bytes).toString("base64url")', 'Buffer.from(bytes).toString("base64").replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "")');
browserCredentials = browserCredentials.replace('Buffer.from(text, "base64url")', 'Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64")');
browserCredentials = browserCredentials.replace('bytes.toString("base64url") === text', 'b64u(bytes) === text');
await writeFile(resolve(root, "src/desktop/credentials.ts"), upstream + `import { Buffer } from "buffer";\nimport { sha256 as hash } from "@noble/hashes/sha2.js";\nimport { hmac } from "@noble/hashes/hmac.js";\nimport { equalBytes } from "@noble/ciphers/utils.js";\n` + browserCredentials);
await mkdir(resolve(root, "tests/fixtures"), { recursive: true });
const vectors = JSON.parse(await readFile(resolve(desktop, "companion/src/e2e/vectors/v1.json"), "utf8"));
await writeFile(resolve(root, "tests/fixtures/e2e-v1.json"), JSON.stringify(Object.fromEntries(["about", "inputs", "V1", "V2", "V3", "V4", "V5"].map(key => [key, vectors[key]])), null, 2) + "\n");

await import("./sync-avatars.mjs");

const defaultBot = await readFile(resolve(desktop, "shared/default-bot.ts"), "utf8");
const defaultFields = defaultBot.slice(defaultBot.indexOf("export interface DefaultBotMark"), defaultBot.indexOf("export interface HelperIntroField"));
const defaultSelection = defaultBot.slice(defaultBot.indexOf("export const defaultBotPerson"), defaultBot.indexOf("/** A DoneBot hidden"));
if (!defaultFields || !defaultSelection) throw new Error("Missing desktop default Bot contract");
await writeFile(resolve(root, "src/desktop/default-bot.ts"), (upstream + defaultFields + defaultSelection).trimEnd() + "\n");

const connectorStatus = await readFile(resolve(desktop, "src/lib/connector-status.ts"), "utf8");
const connectorStart = connectorStatus.indexOf("export interface ConnectorStatus"), connectorEnd = connectorStatus.indexOf("export function needsReconnect");
if (connectorStart < 0 || connectorEnd <= connectorStart) throw new Error("Missing desktop connector status contract");
await writeFile(resolve(root, "src/desktop/connector-status.ts"), (upstream + connectorStatus.slice(connectorStart, connectorEnd)).trimEnd() + "\n");
