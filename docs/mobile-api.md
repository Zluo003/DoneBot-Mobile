# 自有手机连接中枢契约 v1

本契约的客户端、网关和运行服务连接器已实现并通过隔离联调，正式服务尚未上线。账号登录复用 DoneBot 网关；手机使用蜂窝网络访问 HTTPS / WSS 中枢，不依赖与电脑处于同一个 Wi-Fi。电脑必须运行 DoneBot 并保持向自有中继的出站连接；Cloud Bot 由其独立工作空间运行。切换查看位置不会迁移运行中的任务。

## 现有账号接口

网关 JSON 成功包裹 `{ "code": 0, "data": ... }`。客户端兼容裸数据响应，但正式服务应使用网关约定。

| 方法与路径 | 请求 | 成功数据 |
| --- | --- | --- |
| POST `/api/v1/auth/login` | `email`, `password` | `access_token`, `refresh_token`, `expires_in`, `user` |
| POST `/api/v1/auth/login/2fa` | `temp_token`, `totp_code` | 同登录 |
| POST `/api/v1/auth/refresh` | `refresh_token` | 更新后的 token 和有效期 |
| POST `/api/v1/auth/logout` | `refresh_token`，带原 access token | 成功回执 |

需要二次验证时，登录返回 `{ "requires_2fa": true, "temp_token": "..." }`。`user` 至少包含 `id` 和 `email`。

## 手机接口

以下接口必须使用用户 access token，并在服务端逐次验证账号与工作空间归属。工作空间 ID 不能作为授权。

### PUT `/api/v1/donebot/mobile/session`

请求 `{ "installationId": "random-installation-uuid", "name": "DoneBot iPhone", "platform": "ios" }`，注册当前有效登录会话及最近在线时间。App 前台约每 15 秒上报，平台还预留 `android` / `harmony` / `web`。该接口不依赖中继已配置，也不建立聊天连接。

`GET /api/v1/donebot/devices` 供网关个人资料页显示 `{ desktop: [...], mobile: [...], relay_configured: true }`，只包含当前账号的安全元数据。手机进入后台后不承诺持续在线；登录记录和中继会话分别统计。

### GET `/api/v1/donebot/mobile/workspaces`

```json
{
  "workspaces": [
    { "id": "computer-id", "name": "MacBook Pro", "kind": "computer", "online": true, "provisioned": true },
    { "id": "cloud-id", "name": "DoneBot Cloud", "kind": "cloud", "online": true, "provisioned": true }
  ]
}
```

`kind` 为 `computer` 或 `cloud`。服务端从真实实例归属与开通状态投影 Cloud 列表；不创建未开通实例。客户端另有 `provisioned` 过滤。手机协议没有购买或开通接口。

### POST `/api/v1/donebot/mobile/workspaces/:id/connection`

请求体 `{ "installationId": "random-installation-uuid" }`，返回桌面原版协议的连接描述：

```json
{ "v": 1, "k": "P256-public-key-base64url", "h": "host-id-base64url", "r": ["donebot.cn/mobile-relay"], "deviceToken": "omb_REDACTED" }
```

`k` 是 65 字节未压缩 P256 公钥，`h` 是 16 字节主机 ID，均为无填充 base64url。`deviceToken` 必须是这台手机获得授权后的原版设备会话凭据，具有原版会话范围、有效期和撤销能力。它不是网关 access token、网关安装密钥或模型密钥。中枢复核安装归属与原版 refresh family，只把凭据摘要交给运行服务。运行服务登记原版 client 会话并确认后才返回凭据；会话最长租约 70 秒，退出、账号安全版本变化与设备撤销会阻止续租。

正式客户端默认接受 `donebot.cn/mobile-relay`，使用 `wss://donebot.cn/mobile-relay/v1/phone` 和 `omb-relay.v1` 子协议；同时支持独立节点 `relay1.donebot.cn` 至 `relay99.donebot.cn`。网关下发最多 4 个可用地址，优先提供目标电脑当前节点，手机依次尝试。用户无需手动选择节点或扫码配对。代理将 `/mobile-relay/` 去前缀后转发到服务器回环端口 18080，网关继续使用 8080。iOS WebView 的 `capacitor://localhost` 和 Android 容器预留的 `https://localhost` Origin 被明确放行，任意网页 Origin 仍拒绝。

自有中继实现原版握手和双向字节转发。手机与电脑执行原版 Noise NKpsk0 / P256 / AES-GCM / SHA-256 握手，随后使用 yamux 承载 HTTP；消息正文和设备 bearer 在加密通道内传输。中继只需 admission，不读取消息或接收网关密钥。

首次取得的公钥与主机 ID 按账号、工作空间固定在 Keychain；后续变化拒绝连接。首次信任来自自有 HTTPS 账号服务，不能据此声称可抵御中枢首次授权被篡改。重新授权和密钥轮换的签名证明 / 可信重置流程仍需服务端设计与客户端后续接入，当前不会静默覆盖身份。

### PUT `/api/v1/donebot/mobile/push/subscription`

```json
{
  "installationId": "random-installation-uuid",
  "platform": "ios",
  "environment": "sandbox",
  "token": "apns-device-token",
  "preview": false
}
```

注册由手机用户主动开启。服务端将安装 ID 和当前登录账号绑定，原子替换该安装旧账号的绑定；token 仅供推送使用。环境值为 `sandbox` / `production`，不得混用。后续 Android / Harmony 可复用契约形状，但需各自服务端发送通道。

### DELETE `/api/v1/donebot/mobile/push/subscription`

请求体 `{ "installationId": "..." }`。验证当前账号后幂等删除。退出登录等待已发起的订阅完成，再撤销订阅并注销系统推送。服务端还应在账号退出、会话撤销和设备撤销时清理绑定，不能依赖离线手机成功发出 DELETE。

### DELETE `/api/v1/donebot/mobile/session`

请求 `{ "installationId": "..." }`，撤销该账号当前登录会话绑定的手机、连接授权与推送目标。客户端退出时先调用，再退出原版账号；服务端还检查原版 refresh family，不能依赖此请求必达。

## 推送事件与 APNs

电脑 / Cloud 必须在新 Bot 消息落入原会话后向中枢提交经过设备鉴权的消息事件。中枢复核所属账号、工作空间、Bot 与会话，按 `messageId` 去重后发送 APNs alert；不能由手机声明一条消息属于谁。已按用户授权在原版消息入库及回合终止处接入事件调用点，仍由原版会话执行与权限机制处理消息。

推荐 payload：

```json
{
  "aps": { "alert": { "title": "DoneBot", "body": "Bot 有新消息" }, "sound": "default" },
  "accountId": "account-id",
  "workspaceId": "workspace-id",
  "botId": "bot-id",
  "threadId": "thread-id",
  "messageId": "message-id"
}
```

通知默认不包含消息正文。路由元数据会经过 Apple 推送服务；它不是端到端加密消息正文。App 只在账号匹配、目标 Bot 与线程可见时打开，随后从加密通道读取内容。App 前台刷新未读与会话；后台由 APNs 提醒，不依靠后台常驻 WebSocket 或静默推送保活。

APNs 服务端须持有自己的 `.p8`、Key ID、Team ID 和 bundle topic `cn.donebot.mobile`，区分沙盒 / 生产环境，处理失效 token、去重与有限重试。管理员在网关「DoneBot → 手机连接」上传 .p8 并配置，无需新增 APNs 环境变量。这些密钥不进入手机工程。当前客户端不会显示“提醒已开启”，直到 token 已被中枢成功绑定。

## 原版会话接口

手机开放以下加密请求：

- GET `/api/bots?messages=20`（兼容 `messages=1`），同步 `bots`、`sections`、`groups`。保留主协调 / 部门负责人、部门、群成员及最近 Bot 回复。
- GET `/api/threads/:threadId/messages?limit=50[&before=:messageId]`。
- POST `/api/bots/:botId/messages`，正文 `{ "text": "...", "threadId": "...", "sendId": "uuid" }`。
- POST `/api/bots/:botId/read`，正文 `{ "threadId": "..." }`。
- POST `/api/groups/:groupId/messages` 与 `/api/groups/:groupId/read`，复用原版群聊发送、已读与线程机制。
- POST `/api/attachments?uploadId=:uuid`，原始图片字节，`Content-Type` 为图片 MIME。复用原版 10 MB 限额、图片验证、会话上传记录与 UUID 幂等机制。
- POST `/api/threads/:threadId/messages/:messageId/file`，JSON `{ "path": "消息引用的原始路径" }`，返回原始二进制文件。复用原版消息归属、文件引用和工作目录校验，不开放任意路径读取。
- GET `/api/attachments/:name.png|jpg|gif|webp`，用于已保存 Bot 头像，仍通过原版鉴权。
- GET `/api/routines`、`/api/webhooks`、`/api/app-triggers`，读取当前会话可见 Bot 的定时工作、外部事件和应用事件自动化。
- PATCH `/api/routines/:id`，仅接受 `{ "enabled": true|false }`。
- POST `/api/webhooks/:id/enabled`、`/api/app-triggers/:id/enabled`，仅接受同一启用状态请求体；返回原工作记录，不返回 webhook 地址或凭据。
- GET `/api/connectors/connected`，读取所选电脑 / Cloud 的公共连接状态与账号别名，不返回授权密钥。

手机仅管理自动化开关，不提供创建、删除、试运行或内容编辑。额外字段和非布尔状态会被拒绝。网关和中继保持字节转发，不解释或执行自动化；开关变更由目标电脑 / Cloud 的原版管理器处理，需要更新相应运行服务。界面依据响应更新状态，离线禁止修改，失败保留原状态。

读取原版 `unread: boolean` 和消息 `at` 毫秒时间戳。打开会话后固定线程，电脑端切换所选任务不改变手机发送目标。点击通知可进入该 Bot 可见任务中的指定线程，不修改电脑端的任务选择。

发送失败保留草稿和 `sendId`，用户手动重试同一文本时沿用标识；客户端不自动重发发送请求。服务端必须继续使用原版去重和权限检查。手机通过原版 `<attached-image path="..." name="..." />` 格式发送拍摄或图库图片，可以不含文字。附件选择按固定会话保存；上传成功但发送确认丢失时，保留上传结果与发送 ID，重试不重新创建文件。权限卡片和工具操作仍由电脑端处理。

消息保留原版 image / file / audio 附件，以及 Markdown 文件、图片引用。二进制响应支持 Content-Length / chunked、MIME 和 UTF-8 文件名。单文件读取上限 100 MB、传输超时 180 秒；更大的文件会明确提示。客户端在消息同步后自动下载其中引用的图片、视频、音频和文档，最多两个并发；渲染时优先读取账号隔离的本机持久缓存，离线也可预览完整下载过的附件。外部 HTTPS 文件由手机直接读取，不附带网关或设备凭据；浏览器预览受外部站点 CORS 限制。图片、视频在 iOS 中通过 PhotoKit 直接保存到图库，文档保留系统“文件”导出流程。

iOS 平台适配器提供 camera / library、system open / save / share。临时文件位于应用 Cache，操作结束后清理，启动和退出时再次清理。UI 创建的对象 URL 在会话卸载、草稿移除或退出时释放；退出中止未完成的文件读取。Android / Harmony 可以实现相同 `MediaPlatform` 契约。

Bot 列表从相应运行服务同步名称与 avatarUrl、avatarCrop、avatarZoom、avatarFocusX/Y、mascotBody、mascotFaceColor、color；头像不使用网关域名拼接绕过加密通道。

## 已实现的运行服务接口

安装凭据通过原版网关 API Key 校验和 RuntimeInstallation 归属检查：

- POST `/v1/donebot/runtime/mobile/heartbeat`：主机身份、公钥、名称、实际 `relayState` / `relayNode` 及已接受授权摘要；回复短期中继 token、待授权设备摘要、候选节点和最长 70 秒会话租约。
- POST `/v1/donebot/runtime/mobile/events`：原会话落库后的 bot/thread/message ID，禁止发送正文。

主机每 5 秒续约并确认手机授权；未确认的连接请求最长等待 12 秒后返回不可用。网关配置与上线步骤见同级 `donebot-api/docs/donebot-mobile.md`。
