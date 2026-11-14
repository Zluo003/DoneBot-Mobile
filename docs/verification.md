# 首版客户端验证记录

日期：2026-11-14。所有消息写入均在隔离夹具内进行，没有登录真实账号或操作用户的桌面实例 / 数据。首次客户端验证后，后续已按用户授权增加桌面连接器和网关中枢，并完成独立的完整链路验证。

## 自动检查

- `pnpm test`：3 个测试文件、22 项通过。覆盖桌面设备凭据派生、Noise 黄金向量、消息记录加密、篡改 / 重放拒绝、主机身份固定、HTTP 分块、账号切换、登录二次验证、Cloud 过滤、原版时间戳、历史页保留、手动重试去重、线程固定、Bot 撤销、通知跨账号拒绝与退出订阅竞态。
- `pnpm build`：TypeScript 和正式 Vite 构建通过。
- `pnpm ios:build`：Xcode 模拟器构建通过。iOS 应用最低版本 16.4，使用本机临时签名，没有真实 Apple Team 或发布证书。
- 正式产物检查未发现夹具账号、回环中继地址、合成设备 token 或未开通 Cloud 的夹具文案。

## 浏览器流程

通过 Playwright CLI 驱动 `pnpm dev:fixture`，393 × 852 手机尺寸：

1. 合成账号登录，列表分别显示电脑与已开通 Cloud，隐藏未开通 Cloud。
2. 选择 Bot，读取历史，通过原版 Noise / yamux 加密通道发消息并接收合成回复。
3. 返回列表，已读标记清除；按名字搜索 Cloud Bot，列表仅保留匹配项。
4. 打开账号面板并退出，回到登录，旧会话从界面清除。
5. 检查深浅色、320 × 568 小屏与 1024 × 768 平板。320px 下无页面横向溢出，输入框和发送按钮均在视口内。
6. 登录页顶部重复品牌栏已按用户要求移除，仅保留表单上方主 Logo。浏览器最后检查无 error / warning。

截图位于本机 `output/playwright/`，包括 `login-light.png`、`bots-light.png`、`bots-dark.png`、`chat-light.png`、`chat-dark.png`、`chat-narrow.png`、`tablet-dark.png`。

## 原版桌面真实接口

按 DoneBot 的 `docs/verification/README.md` 启动：

```sh
node --experimental-strip-types scripts/control-omb.ts launch
```

本次打印的隔离地址是 `http://127.0.0.1:20395`。以下地址只代表该次夹具，重新运行时必须使用新打印的地址。

```sh
pnpm control:omb new-bot --name MobileProbe --url http://127.0.0.1:20395
```

Bot ID：`490fd212-811f-4b29-af32-0e2bd8ea0553`；thread ID：`8634903d-8cd8-4b6f-b222-b975a3d074a3`。

在 Mobile 工程启动中继桥：

```sh
MOBILE_DESKTOP_FIXTURE_URL=http://127.0.0.1:20395 MOBILE_FIXTURE_PORT=5175 pnpm dev:fixture
```

浏览器访问 `http://127.0.0.1:5175`，使用合成账号登录，选择 MobileProbe，发送 `Mobile encrypted fixture verification.`。移动端实际通过加密通道调用原版 `/api/bots/:id/messages`，读取原版 `/api/threads/:id/messages`。随后使用桌面控制面核验：

```sh
pnpm control:omb wait --bot 490fd212-811f-4b29-af32-0e2bd8ea0553 --timeout 30 --url http://127.0.0.1:20395
pnpm control:omb messages --bot 490fd212-811f-4b29-af32-0e2bd8ea0553 --limit 5 --url http://127.0.0.1:20395
```

结果为 `settled`，原会话包含该用户消息和 `hello from fake claude`。移动界面也显示这两条消息。回执保留在本机 `output/desktop-wait.json` 与 `output/desktop-messages.json`。

桌面日志：`/var/folders/wf/gs6jc_rd4qd_6_1jmqjkg1jh0000gn/T/donebot-verification-evidence/server-1794656126653-40478.log`。验证后按 Ctrl-C 关闭该夹具和中继桥，由 launcher 清理自己的临时资料目录。

此项证明原版消息 API 与移动加密传输兼容。账号发现和设备凭据由合成中枢提供，桥的回环授权只用于夹具，不能推断正式设备授权或公网部署已完成。

## iOS 原生

在 iOS 26.5 / iPhone 17 Pro 模拟器安装、启动正式网页产物，确认单 Logo 登录布局、原生桥可用、无登录存储读取错误。

另复制编译产物到 `.build/vault-smoke.app`，仅在该副本中替换页面，调用实际 `DoneBotVault` 插件，用合成键值完成写入 → 读取 → 删除 → 再读为空，并验证推送环境为 `sandbox`，页面显示 PASS。未调用登录或网络接口。截图保留 `output/playwright/ios-vault-smoke.png`。随后重新安装正式客户端产物，临时测试页面不进入源码或正式包。

## 尚未验证

- 正式账号的设备发现、真实设备授权、自有公网中继、蜂窝网络连接。
- 真机 APNs token、后台送达、通知冷启动、退出后的服务端撤销。
- Android 系统适配及原生 HarmonyOS 容器。

上述功能需要中枢 / APNs 服务端和设备侧事件接入，详见 `mobile-api.md`。当前的通过结果不代表这些服务已经可用。

## 自有中枢完整链路

后续通过 `donebot-api/backend/internal/mobilehub` 的临时 PostgreSQL 测试与 `DoneBot/scripts/verify-mobile-hub.ts` 联调，使用真实中枢 SQL、原版 relay 服务、原版隔离桌面与本项目正式加密传输代码。

已验证电脑登记、工作空间归属、手机授权确认、原版 client scope、Bot 列表和会话历史、文本发送与原会话回复、通知 outbox、无聊天正文的通知 payload、退出后加密连接撤销。联调发现并修复手机提前发送 FIN 使异步 HTTP 响应中断的问题；手机现在等服务端完成响应后再结束流。

记录位于 `/Users/zluo/Dev/DoneBot/.omb-scratch/verify-evidence/mobile-hub/evidence.json`。本次成功桌面日志为 `/var/folders/wf/gs6jc_rd4qd_6_1jmqjkg1jh0000gn/T/donebot-verification-evidence/server-1794659938399-50968.log`。夹具已关闭，并清理自己创建的运行资料和数据库。

APNs ES256 签名、沙盒目标、无效 token 与临时拒绝由内存 HTTP transport 验证；工作流通知发送使用合成通道，未向 Apple 发送真实推送。正式网关部署、真实 Cloud 节点、蜂窝网络和后台推送仍需在配置自有域名及 Apple 凭据后验收。
