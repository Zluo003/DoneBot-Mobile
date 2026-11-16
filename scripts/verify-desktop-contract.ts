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
  const { directorySchema, messagePageSchema } = await vite.ssrLoadModule("/src/core/contracts.ts");
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
  const { conversationList, latestConversation } = await vite.ssrLoadModule("/src/core/conversations.ts");
  const originalThread = target.threadId;
  const { task } = await api("POST", `/api/bots/${target.id}/tasks`, { title: "手机切换验证", select: false });
  const routed = await api("POST", `/api/bots/${target.id}/messages`, { threadId: task.threadId, text: "Mobile conversation switch fixture.", sendId: crypto.randomUUID() });
  assert.equal(routed.threadId, task.threadId);
  let history;
  const until = Date.now() + 30_000;
  do {
    history = messagePageSchema.parse(await api("GET", `/api/threads/${task.threadId}/messages?limit=50`));
    if (history.messages.some((message: { role: string; kind: string }) => message.role === "bot" && message.kind === "text")) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  } while (Date.now() < until);
  assert.ok(history.messages.some((message: { role: string; kind: string }) => message.role === "bot" && message.kind === "text"), "fake engine replied in the explicit alternate conversation");
  const wire = directorySchema.parse(await api("GET", "/api/bots?messages=20"));
  const bot = wire.bots.find((bot: { id: string }) => bot.id === target.id);
  assert.equal(bot.threadId, originalThread, "phone-style send does not select a desktop conversation");
  const alternate = bot.tasks.find((item: { threadId: string }) => item.threadId === task.threadId);
  assert.equal(typeof alternate.title, "string"); assert.equal(typeof alternate.updatedAt, "number");
  const list = conversationList(bot, (threadId: string) => threadId === task.threadId ? history : { messages: bot.messages, hasMore: bot.hasMore });
  assert.equal(latestConversation(list, originalThread).threadId, task.threadId);
  await api("POST", `/api/bots/${target.id}/read`, { threadId: task.threadId });
  const read = directorySchema.parse(await api("GET", "/api/bots?messages=20")).bots.find((bot: { id: string }) => bot.id === target.id);
  assert.equal(read.tasks.find((item: { threadId: string }) => item.threadId === task.threadId).unread, false);
  assert.equal(read.threadId, originalThread);
  checks.push("Real shared desktop/Cloud task metadata, explicit alternate-thread send/reply/read, latest-reply default, and independent desktop selection");
  const receipt = { passed: true, checks, url: fixture.info.url, log: fixture.info.logPath, liveDataTouched: false,
    limitations: "Uses the real desktop/Cloud shared HTTP handler and Mobile parser against a disposable local fake-engine runtime. Does not inspect the user's deployed Cloud image or physical phone." };
  await writeFile(join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
  console.log(`Contract evidence: ${output}`);
} finally {
  await fixture.close();
  await vite.close();
}
