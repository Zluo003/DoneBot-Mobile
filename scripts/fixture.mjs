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
  { id: "duobao", name: "多宝", title: "你的工作搭档", emoji: "🐹", threadId: "thread-duobao", workspaceId: "macbook", busy: false, unread: true },
  { id: "xiaolu", name: "小鹿", title: "内容与创作", emoji: "🦌", threadId: "thread-xiaolu", workspaceId: "macbook", busy: false, unread: false },
  { id: "ahe", name: "阿和", title: "研究与整理", emoji: "🦉", threadId: "thread-ahe", workspaceId: "cloud", busy: false, unread: true },
];
const histories = new Map([
  ["thread-duobao", [
    { id: "m1", role: "user", kind: "text", text: "帮我整理一下今天需要关注的事情。", timestamp: at(16) },
    { id: "m2", role: "bot", kind: "text", text: "整理好了，今天有三件事值得关注：\n\n1. **手机端开发**：先把登录、Bot 列表和聊天跑通。\n2. **产品资料**：新的介绍文档已经整理好，可以继续完善。\n3. **本周计划**：还有两项工作需要你确认优先级。\n\n你想先从哪一件开始？", timestamp: at(14) },
    { id: "m3", role: "user", kind: "text", text: "先看手机端，保持简单。", timestamp: at(10) },
    { id: "m4", role: "bot", kind: "text", text: "好，就保留最常用的部分：登录、找到 Bot、接着聊。有新消息时，我会提醒你。", timestamp: at(9) },
  ]],
  ["thread-xiaolu", [{ id: "c1", role: "bot", kind: "text", text: "介绍文档的初稿整理好了，随时可以一起看看。", timestamp: at(36) }]],
  ["thread-ahe", [{ id: "a1", role: "bot", kind: "text", text: "资料已经按主题归档，三份重点摘要也准备好了。", timestamp: at(58) }]],
]);
const received = new Set();
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
    if (req.method === "GET" && url.pathname === "/api/bots") return json(res, 200, { bots: bots.filter(bot => !workspace || bot.workspaceId === workspace).map(bot => ({ ...bot, messages: histories.get(bot.threadId).slice(-1) })) });
    const thread = /^\/api\/threads\/([^/]+)\/messages$/.exec(url.pathname);
    if (thread && req.method === "GET") return json(res, 200, { messages: histories.get(thread[1]) ?? [], hasMore: false });
    const target = /^\/api\/bots\/([^/]+)\/(messages|read)$/.exec(url.pathname);
    if (target && req.method === "POST") {
      const body = await read(req);
      const bot = bots.find(bot => bot.id === target[1]);
      if (!bot) return json(res, 404, {});
      if (target[2] === "read") { bot.unread = false; return json(res, 200, { ok: true }); }
      if (!body.text || !body.sendId || body.threadId !== bot.threadId) return json(res, 400, {});
      if (received.has(body.sendId)) return json(res, 200, { threadId: bot.threadId });
      received.add(body.sendId);
      const message = { id: crypto.randomUUID(), role: "user", kind: "text", text: body.text, sendId: body.sendId, timestamp: new Date().toISOString() };
      histories.get(bot.threadId).push(message); bot.busy = true;
      setTimeout(() => {
        histories.get(bot.threadId).push({ id: crypto.randomUUID(), role: "bot", kind: "text", text: `收到：${body.text}\n\n这条回复来自隔离验证服务。消息已通过与桌面端兼容的加密通道往返。`, timestamp: new Date().toISOString() });
        bot.busy = false; bot.unread = true;
      }, 650).unref();
      return json(res, 200, { threadId: bot.threadId, message });
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
    if (url.pathname === "/api/v1/donebot/mobile/workspaces") return json(res, 200, { workspaces: [
      { id: "macbook", name: "MacBook Pro", kind: "computer", online: true, provisioned: true },
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
                const raw = chunk.toString();
                chunk = Buffer.from(desktopFixture
                  ? raw.replace(`Authorization: Bearer ${deviceToken}\r\n`, "").replace("Host: donebot.e2e.invalid", `Host: ${desktopFixture.host}`)
                  : raw.replace(`Bearer ${deviceToken}`, `Bearer ${token}`).replace("\r\n\r\n", `\r\nX-Fixture-Workspace: ${workspaceId}\r\n\r\n`));
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
console.log(JSON.stringify({ url: `http://127.0.0.1:${webPort}`, api: process.env.MOBILE_FIXTURE_ORIGIN, account: account.email, password: "donebot-preview", isolated: true, desktopFixture: desktopFixture?.origin }));
const close = async () => { for (const socket of wss.clients) socket.terminate(); await vite.close(); server.close(); rpc.close(); process.exit(0); };
process.on("SIGINT", close); process.on("SIGTERM", close);
