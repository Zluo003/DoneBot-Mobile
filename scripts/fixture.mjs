import { readFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { createServer } from "vite";
import { E2ESession } from "../../DoneBot/companion/src/e2e/session.ts";
import { generateKeyPair } from "../../DoneBot/companion/src/e2e/noise.ts";
import { credentialHash, keyId, psk, admission, b64u, sameBytes, fromB64u } from "../../DoneBot/companion/src/e2e/credentials.ts";

const token = "omb_fixture_only_not_a_real_device_token";
const key = generateKeyPair();
const hostId = Buffer.alloc(16, 7);
const credHash = credentialHash(token);
const transportPsk = psk(credHash, keyId(key.publicKey));
const at = minutes => new Date(Date.now() - minutes * 60_000).toISOString();
const bots = [
  { id: "duobao", defaultBot: {}, chiefOfStaff: true, name: "多宝", title: "你的工作搭档", color: "orange", mascotBody: "blob", threadId: "thread-duobao", workspaceId: "macbook", busy: false, unread: true },
  { id: "xiaolu", section: "内容与创作", chiefOfStaff: true, name: "小鹿", title: "内容与创作", color: "blue", avatarCrop: "rounded", avatarUrl: "/api/attachments/fixture-avatar.png", avatarZoom: 1.2, avatarFocusX: 0.4, threadId: "thread-xiaolu", workspaceId: "macbook", busy: false, unread: false },
  { id: "ahe", defaultBot: {}, chiefOfStaff: true, name: "阿和", title: "研究与整理", color: "purple", mascotBody: "star", threadId: "thread-ahe", workspaceId: "cloud", busy: false, unread: true },
];
const groups = [{ id: "creative-room", name: "创意讨论室", threadId: "thread-room", memberIds: ["duobao", "xiaolu"], section: "内容与创作", workspaceId: "macbook", working: false, unread: true }];
const routines = [
  { id: "daily-brief", name: "每日工作简报", botId: "duobao", enabled: true, prompt: "整理今天的工作进展与需要关注的事项。", nextRunAt: Date.now() + 3600_000, workspaceId: "macbook" },
  { id: "weekly-research", name: "每周资料归档", botId: "ahe", enabled: false, prompt: "归档本周收集的研究资料。", nextRunAt: null, workspaceId: "cloud" },
];
const webhooks = [{ id: "incoming-update", name: "项目更新通知", botId: "xiaolu", enabled: true, prompt: "收到项目更新后整理重点。", workspaceId: "macbook" }];
const appTriggers = [{ id: "mail-followup", name: "新邮件跟进", botId: "duobao", enabled: false, prompt: "收到客户新邮件后准备回复草稿。", appName: "Gmail", eventName: "收到新邮件", workspaceId: "macbook" }];
const histories = new Map([
  ["thread-room", [
    { id: "room-reply", role: "bot", kind: "text", text: "两版方案都整理好了，可以一起讨论。", from: { botId: "xiaolu", name: "小鹿", color: "blue" }, timestamp: at(7) },
    { id: "room-user", role: "user", kind: "text", text: "这条用户消息不应成为列表的最后回复。", timestamp: at(5) },
  ]],
  ["thread-duobao", [
    { id: "tool-activity", role: "bot", kind: "activity", text: "Fixture hidden tool activity", timestamp: at(17) },
    { id: "tool-digest", role: "bot", kind: "digest", text: "Fixture hidden execution digest", timestamp: at(17) },
    { id: "m1", role: "user", kind: "text", text: "帮我整理一下今天需要关注的事情。", timestamp: at(16) },
    { id: "m2", role: "bot", kind: "text", text: "整理好了，今天有三件事值得关注：\n\n1. **手机端开发**：先把登录、Bot 列表和聊天跑通。\n2. **产品资料**：新的介绍文档已经整理好，可以继续完善。\n3. **本周计划**：还有两项工作需要你确认优先级。\n\n你想先从哪一件开始？", timestamp: at(14) },
    { id: "m3", role: "user", kind: "text", text: "先看手机端，保持简单。", timestamp: at(10) },
    { id: "m4", role: "bot", kind: "text", text: "好，就保留最常用的部分：登录、找到 Bot、接着聊。有新消息时，我会提醒你。", timestamp: at(9) },
  ]],
  ["thread-xiaolu", [{ id: "c1", role: "bot", kind: "text", text: "介绍文档的初稿整理好了，随时可以一起看看。", timestamp: at(36) }]],
  ["thread-ahe", [{ id: "a1", role: "bot", kind: "text", text: "资料已经按主题归档，三份重点摘要也准备好了。", timestamp: at(58) }]],
]);
const received = new Set();
const offlineComputers = process.env.MOBILE_DEVICES_FIXTURE === "1" ? [
  { id: "offline-home", name: "家里的电脑", kind: "computer", online: false, provisioned: true },
  { id: "offline-office", name: "办公室电脑", kind: "computer", online: false, provisioned: true },
] : [];
const removedComputers = new Set();
const files = new Map();
for (const [name, mime] of [["photo.png", "image/png"], ["demo.mp4", "video/mp4"], ["note.wav", "audio/wav"], ["guide.pdf", "application/pdf"], ["notes.txt", "text/plain"]]) {
  files.set(`/fixture/${name}`, { bytes: await readFile(new URL(`../tests/fixtures/media/${name}`, import.meta.url)), mime, name });
}
files.set("/api/attachments/fixture-avatar.png", files.get("/fixture/photo.png"));
files.set("/fixture/jimeng-image-generate-20261114155450727-fixture.png", files.get("/fixture/photo.png"));
histories.get("thread-xiaolu").push({ id: "files", role: "bot", kind: "text", text: "文件已准备好，可以在手机上查看、保存或转发。\n\n[文字说明](/fixture/notes.txt)", timestamp: at(1), attachments: [
  { kind: "image", path: "/fixture/photo.png", mime: "image/png", name: "预览图.png" },
  { kind: "file", path: "/fixture/demo.mp4", mime: "video/mp4", name: "演示视频.mp4" },
  { kind: "audio", path: "/fixture/note.wav", mime: "audio/wav", name: "语音.wav" },
  { kind: "file", path: "/fixture/guide.pdf", mime: "application/pdf", name: "使用指南.pdf" },
] });
histories.get("thread-xiaolu").push({ id: "generated-image", role: "bot", kind: "text", text: "", timestamp: at(0), attachments: [{ kind: "image", path: "/fixture/jimeng-image-generate-20261114155450727-fixture.png", mime: "image/png", name: "生成图片.png" }] });
if (process.env.MOBILE_ATTENTION_FIXTURE === "1") {
  bots[0].busy = true;
  bots[1].busy = true; bots[1].unread = true; bots[1].lastReadMessageId = "c1";
  bots.splice(1, 0, { id: "writer", name: "小林", section: "内容与创作", color: "green", threadId: "thread-writer", workspaceId: "macbook", unread: true, busy: true, lastReadMessageId: "writer-4" });
  bots.push({ id: "cloud-writer", name: "Cloud 创作", section: "内容与创作", color: "blue", threadId: "thread-cloud-writer", workspaceId: "cloud", unread: true, busy: false });
  histories.set("thread-writer", Array.from({ length: 65 }, (_, i) => ({ id: `writer-${i}`, role: "bot", kind: "text", text: `合成未读消息 ${i}`, timestamp: at(65 - i) })));
  histories.set("thread-cloud-writer", [{ id: "cloud-1", role: "bot", kind: "text", text: "Cloud 合成消息", timestamp: at(1) }]);
}
if (process.env.MOBILE_CONVERSATIONS_FIXTURE === "1") {
  histories.set("thread-plan", [{ id: "plan-reply", role: "bot", kind: "text", text: "视频方案已整理，接着确认参考素材。", timestamp: at(2) }]);
  histories.set("thread-archived", [{ id: "archive-reply", role: "bot", kind: "text", text: "归档后的较新回复不改变默认对话。", timestamp: at(0) }]);
  bots[0].unread = true;
  bots[0].tasks = [
    { threadId: "thread-duobao", title: "日常工作", unread: true },
    { threadId: "thread-plan", title: "视频方案", unread: false },
    { threadId: "thread-archived", title: "已完成的工作", archivedAt: Date.now(), unread: false },
  ];
  histories.set("thread-cloud-plan", [{ id: "cloud-plan-reply", role: "bot", kind: "text", text: "Cloud 对话列表已准备好。", timestamp: at(0) }]);
  bots[2].tasks = [{ threadId: "thread-ahe", title: "资料归档", unread: true }, { threadId: "thread-cloud-plan", title: "新的研究", unread: false }];
}
const wireTasks = bot => bot.tasks?.map(task => ({ ...task, updatedAt: Math.max(0, ...(histories.get(task.threadId) ?? []).map(message => new Date(message.timestamp).getTime())) }));
const messagePage = (threadId, limit, before) => {
  const all = histories.get(threadId) ?? [];
  const end = before ? all.findIndex(message => message.id === before) : all.length;
  const start = Math.max(0, end - limit);
  return { messages: all.slice(start, end), hasMore: start > 0 };
};
const raw = async (req, limit = 10 * 1024 * 1024) => { const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error("oversized"); chunks.push(chunk); } return Buffer.concat(chunks); };
const binary = (res, file) => { res.writeHead(200, { "content-type": file.mime, "content-length": file.bytes.length, "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}` }); res.end(file.bytes); };
const desktopFixture = process.env.MOBILE_DESKTOP_FIXTURE_URL ? new URL(process.env.MOBILE_DESKTOP_FIXTURE_URL) : null;
if (desktopFixture && (desktopFixture.protocol !== "http:" || desktopFixture.hostname !== "127.0.0.1" || !desktopFixture.port || desktopFixture.pathname !== "/" || desktopFixture.search || desktopFixture.hash || desktopFixture.username || desktopFixture.password)) throw new Error("Only an explicitly launched loopback fixture is supported");
const webPort = Number(process.env.MOBILE_FIXTURE_PORT || 5174);
const account = { id: "fixture-user", email: "preview@donebot.test", username: "预览账号" };
const json = (res, status, value) => { const bytes = Buffer.from(JSON.stringify(value)); res.writeHead(status, { "content-type": "application/json", "content-length": bytes.length, "cache-control": "no-store" }); res.end(bytes); };
const read = async req => { const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > 128 * 1024) throw new Error("oversized"); chunks.push(chunk); } return size ? JSON.parse(Buffer.concat(chunks).toString()) : {}; };

const rpc = http.createServer(async (req, res) => {
  try {
    if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, {});
    const url = new URL(req.url, "http://fixture.invalid");
    const workspace = req.headers["x-fixture-workspace"];
    if (req.method === "GET" && ["/api/routines", "/api/webhooks", "/api/app-triggers"].includes(url.pathname)) {
      const [key, items] = url.pathname === "/api/routines" ? ["routines", routines] : url.pathname === "/api/webhooks" ? ["webhooks", webhooks] : ["triggers", appTriggers];
      return json(res, 200, { [key]: items.filter(item => item.workspaceId === workspace) });
    }
    if (req.method === "GET" && url.pathname === "/api/connectors/connected") return json(res, 200, { credentialStore: "ok", inventoryComplete: true, services: workspace === "cloud" ? { notion: { connected: true, accounts: [{ id: "notion-fixture", alias: "研究资料", status: "ACTIVE" }] } } : { gmail: { connected: true, accounts: [{ id: "gmail-fixture", alias: "preview@donebot.test", status: "ACTIVE" }] }, slack: { connected: false, accounts: [{ id: "slack-fixture", alias: "创作团队", status: "EXPIRED" }] } } });
    const toggle = /^\/api\/(routines|webhooks|app-triggers)\/([\w-]+)(\/enabled)?$/.exec(url.pathname);
    if (toggle && req.method === (toggle[1] === "routines" ? "PATCH" : "POST")) {
      const item = (toggle[1] === "routines" ? routines : toggle[1] === "webhooks" ? webhooks : appTriggers).find(item => item.id === toggle[2] && item.workspaceId === workspace);
      if (!item) return json(res, 404, {});
      const body = await read(req);
      if (Object.keys(body).length !== 1 || typeof body.enabled !== "boolean") return json(res, 400, {});
      item.enabled = body.enabled;
      return json(res, 200, { [toggle[1] === "routines" ? "routine" : toggle[1] === "webhooks" ? "webhook" : "trigger"]: item });
    }
    if (req.method === "GET" && url.pathname === "/api/bots") return json(res, 200, {
      bots: bots.filter(bot => !workspace || bot.workspaceId === workspace).map(bot => ({ ...bot, tasks: wireTasks(bot), ...messagePage(bot.threadId, Number(url.searchParams.get("messages") || 1)) })),
      sections: workspace === "cloud" && process.env.MOBILE_ATTENTION_FIXTURE !== "1" ? [] : ["内容与创作"],
      groups: groups.filter(group => !workspace || group.workspaceId === workspace).map(group => ({ ...group, ...messagePage(group.threadId, Number(url.searchParams.get("messages") || 1)) })),
    });
    const thread = /^\/api\/threads\/([^/]+)\/messages$/.exec(url.pathname);
    if (thread && req.method === "GET") return json(res, 200, messagePage(thread[1], Number(url.searchParams.get("limit") || 50), url.searchParams.get("before")));
    if (req.method === "GET" && url.pathname === "/api/attachments/fixture-avatar.png") return binary(res, files.get(url.pathname));
    if (req.method === "POST" && url.pathname === "/api/attachments") {
      const id = url.searchParams.get("uploadId");
      const path = `/api/attachments/${id}.png`;
      const bytes = await raw(req);
      files.set(path, { bytes, mime: req.headers["content-type"], name: "上传图片.png" });
      return json(res, 201, { path, mime: req.headers["content-type"], bytes: bytes.length });
    }
    if (req.method === "POST" && url.pathname === "/api/files") {
      const name = url.searchParams.get("name"), path = `/fixture/uploads/${url.searchParams.get("uploadId")}/${name}`;
      const bytes = await raw(req, 100 * 1024 * 1024);
      files.set(path, { bytes, mime: req.headers["content-type"], name });
      return json(res, 201, { path, mime: req.headers["content-type"], bytes: bytes.length });
    }
    const download = /^\/api\/threads\/([^/]+)\/messages\/([^/]+)\/file$/.exec(url.pathname);
    if (download && req.method === "POST") {
      const { path } = await read(req);
      const message = histories.get(download[1])?.find(message => message.id === download[2]);
      if (!message || !(message.attachments?.some(attachment => attachment.path === path) || message.text.includes(path)) || !files.has(path)) return json(res, 403, {});
      return binary(res, files.get(path));
    }
    const target = /^\/api\/(bots|groups)\/([^/]+)\/(messages|read)$/.exec(url.pathname);
    if (target && req.method === "POST") {
      const body = await read(req);
      const bot = (target[1] === "groups" ? groups : bots).find(bot => bot.id === target[2]);
      if (!bot) return json(res, 404, {});
      const threadId = body.threadId ?? bot.threadId, task = bot.tasks?.find(task => task.threadId === threadId);
      if (threadId !== bot.threadId && !task) return json(res, 404, {});
      if (target[3] === "read") {
        if (task) { task.unread = false; task.lastReadMessageId = histories.get(threadId)?.at(-1)?.id; }
        bot.unread = bot.tasks?.some(task => task.unread) ?? false;
        if (threadId === bot.threadId) bot.lastReadMessageId = histories.get(threadId)?.at(-1)?.id;
        return json(res, 200, { ok: true });
      }
      if (!body.text || !body.sendId) return json(res, 400, {});
      if (received.has(body.sendId)) return json(res, 200, { threadId });
      received.add(body.sendId);
      const message = { id: crypto.randomUUID(), role: "user", kind: "text", text: body.text, sendId: body.sendId, timestamp: new Date().toISOString() };
      histories.get(threadId).push(message); bot.busy = true; bot.working = true;
      setTimeout(() => {
        histories.get(threadId).push({ id: crypto.randomUUID(), role: "bot", kind: "text", text: `收到：${body.text}\n\n这条回复来自隔离验证服务。消息已通过与桌面端兼容的加密通道往返。`, timestamp: new Date().toISOString() });
        if (task) task.unread = true;
        bot.busy = false; bot.working = false; bot.unread = true;
      }, 650).unref();
      return json(res, 200, { threadId, message });
    }
    json(res, 404, {});
  } catch { json(res, 400, {}); }
});
rpc.listen(0, "127.0.0.1"); await once(rpc, "listening");
const workspaceByToken = new Map();
let port;
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://fixture.invalid");
    if (url.pathname === "/api/v1/auth/login") {
      const body = await read(req);
      if (body.email !== account.email || body.password !== "donebot-preview") return json(res, 401, {});
      return json(res, 200, { code: 0, data: { access_token: "fixture-access", refresh_token: "fixture-refresh", expires_in: 3600, user: account } });
    }
    if (url.pathname === "/api/v1/auth/refresh") return json(res, 200, { code: 0, data: { access_token: "fixture-access", refresh_token: "fixture-refresh", expires_in: 3600 } });
    if (req.headers.authorization !== "Bearer fixture-access") return json(res, 401, {});
    if (url.pathname === "/api/v1/auth/logout") return json(res, 200, {});
    const removal = /^\/api\/v1\/donebot\/mobile\/workspaces\/(offline-home|offline-office)$/.exec(url.pathname);
    if (removal && req.method === "DELETE" && offlineComputers.some(workspace => workspace.id === removal[1])) {
      removedComputers.add(removal[1]); res.writeHead(204); res.end(); return;
    }
    if (url.pathname === "/api/v1/donebot/mobile/workspaces") return json(res, 200, { workspaces: [
      { id: "macbook", name: "MacBook Pro", kind: "computer", online: true, provisioned: true },
      ...offlineComputers.filter(workspace => !removedComputers.has(workspace.id)),
      ...(!desktopFixture ? [{ id: "cloud", name: "DoneBot Cloud", kind: "cloud", online: true, provisioned: true }] : []),
      { id: "hidden-cloud", name: "尚未开通的 Cloud", kind: "cloud", online: false, provisioned: false },
    ] });
    const connection = /^\/api\/v1\/donebot\/mobile\/workspaces\/(macbook|cloud)\/connection$/.exec(url.pathname);
    if (connection && req.method === "POST") {
      const deviceToken = `omb_fixture_workspace_${connection[1]}`;
      workspaceByToken.set(deviceToken, connection[1]);
      return json(res, 200, { v: 1, k: b64u(key.publicKey), h: b64u(hostId), r: [`127.0.0.1:${port}`], deviceToken });
    }
    if (url.pathname === "/api/v1/donebot/mobile/session") return json(res, 200, { ok: true });
    if (url.pathname === "/api/v1/donebot/mobile/push/subscription") return json(res, 200, { ok: true });
    json(res, 404, {});
  } catch { json(res, 400, {}); }
});
const wss = new WebSocketServer({ server, path: "/fixture-relay/phone" });
wss.on("connection", socket => {
  let session;
  let peer;
  socket.on("message", (data, binary) => {
    if (!session) {
      try {
        const hello = JSON.parse(data.toString());
        if (binary || hello.t !== "phone" || hello.hid !== b64u(hostId)) return socket.close(4404);
        peer = [...workspaceByToken].find(([deviceToken]) => sameBytes(admission(credentialHash(deviceToken), hostId), fromB64u(hello.adm) ?? Buffer.alloc(0)));
        if (!peer) return socket.close(4404);
        const [deviceToken, workspaceId] = peer;
        session = E2ESession.computer({
          transport: { send: bytes => socket.send(bytes), close: code => socket.close(code), get bufferedAmount() { return socket.bufferedAmount; }, onceDrained: callback => setTimeout(callback, 10) },
          transportByte: 1, staticKey: key, candidates: () => [{ id: "fixture-phone", psk: psk(credentialHash(deviceToken), keyId(key.publicKey)) }],
          connectOrigin: async () => {
            const proxy = net.createConnection({ host: "127.0.0.1", port: desktopFixture ? Number(desktopFixture.port) : rpc.address().port });
            const originalWrite = proxy.write.bind(proxy); let first = true;
            proxy.write = function (chunk, ...args) {
              if (first) {
                first = false;
                const bytes = Buffer.from(chunk);
                const boundary = bytes.indexOf("\r\n\r\n");
                if (boundary < 0) throw new Error("Incomplete fixture request headers");
                const raw = bytes.subarray(0, boundary + 4).toString();
                const headers = desktopFixture
                  ? raw.replace(`Authorization: Bearer ${deviceToken}\r\n`, "").replace("Host: donebot.e2e.invalid", `Host: ${desktopFixture.host}`)
                  : raw.replace(`Bearer ${deviceToken}`, `Bearer ${token}`).replace("\r\n\r\n", `\r\nX-Fixture-Workspace: ${workspaceId}\r\n\r\n`);
                chunk = Buffer.concat([Buffer.from(headers), bytes.subarray(boundary + 4)]);
              }
              return originalWrite(chunk, ...args);
            };
            await once(proxy, "connect"); return proxy;
          },
        });
        void session.ready.catch(() => {});
        socket.send(JSON.stringify({ t: "ready" }));
      } catch { socket.close(4400); }
    } else session.receive(new Uint8Array(data), binary);
  });
  socket.on("close", () => session?.transportClosed(1000));
});
server.listen(0, "127.0.0.1"); await once(server, "listening"); port = server.address().port;
process.env.MOBILE_FIXTURE_ORIGIN = `http://127.0.0.1:${port}`;
const vite = await createServer({ mode: "fixture", server: { port: webPort, strictPort: true } });
await vite.listen();
console.log(JSON.stringify({ url: `http://127.0.0.1:${webPort}`, api: process.env.MOBILE_FIXTURE_ORIGIN, rpc: `http://127.0.0.1:${rpc.address().port}`, account: account.email, password: "donebot-preview", isolated: true, desktopFixture: desktopFixture?.origin }));
const close = async () => { for (const socket of wss.clients) socket.terminate(); await vite.close(); server.close(); rpc.close(); process.exit(0); };
process.on("SIGINT", close); process.on("SIGTERM", close);
