import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import { launchVerificationServer } from "../../DoneBot/scripts/control-omb.ts";

const output = await mkdtemp(join(tmpdir(), "donebot-mobile-contract-"));
const vite = await createServer({ root: new URL("..", import.meta.url).pathname, server: { middlewareMode: true }, appType: "custom" });
const fixture = await launchVerificationServer();
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", origin: fixture.info.url }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.ok(response.ok, `${method} ${path}: ${response.status}`);
  return response.json();
};
try {
  const { directorySchema } = await vite.ssrLoadModule("/src/core/contracts.ts");
  const { avatarState } = await vite.ssrLoadModule("/src/ui/avatar-state.ts");
  const bots = (await api("GET", "/api/bots")).bots;
  const target = bots[0];
  const checks: string[] = [];
  const { documentFile } = await vite.ssrLoadModule("/src/core/documents.ts");
  const document = documentFile({ name: "验证文档.txt", blob: new Blob(["isolated document upload\n"]) });
  const uploadId = crypto.randomUUID();
  const upload = async () => {
    const response = await fetch(fixture.info.url + `/api/files?uploadId=${uploadId}&name=${encodeURIComponent(document.name)}`, {
      method: "POST", headers: { origin: fixture.info.url, "content-type": document.blob.type }, body: document.blob,
    });
    assert.equal(response.ok, true); return response.json();
  };
  const first = await upload(), retried = await upload();
  assert.deepEqual(first, retried); assert.equal(first.bytes, document.blob.size); assert.equal(first.mime, "text/plain");
  checks.push("Mobile document normalization uses original isolated runtime upload validation and idempotent retry");
  for (const expression of ["proud", "happy", "focused", null]) {
    await api("PATCH", `/api/bots/${target.id}`, { mascotExpression: expression });
    const wire = await api("GET", "/api/bots?messages=20");
    const parsed = directorySchema.parse(wire);
    const bot = parsed.bots.find((bot: { id: string }) => bot.id === target.id);
    assert.equal(bot.mascotExpression, expression);
    assert.equal(parsed.bots.length, wire.bots.length);
    if (expression) assert.equal(avatarState(bot), expression === "focused" ? "working" : expression);
    checks.push(`real isolated runtime directory accepted with expression ${expression}`);
  }
  const receipt = { passed: true, checks, url: fixture.info.url, log: fixture.info.logPath, liveDataTouched: false,
    limitations: "Uses the real desktop/Cloud shared HTTP handler and Mobile parser against a disposable local fake-engine runtime. Does not inspect the user's deployed Cloud image or physical phone." };
  await writeFile(join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
  console.log(`Contract evidence: ${output}`);
} finally {
  await fixture.close();
  await vite.close();
}
