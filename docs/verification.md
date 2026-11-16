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

APNs ES256 签名、沙盒目标、无效 token 与临时拒绝由内存 HTTP transport 验证；工作流通知发送使用合成通道，未向 Apple 发送真实推送。正式网关部署、真实 Cloud 节点、蜂窝网络和后台推送仍需在配置自有服务及 Apple 凭据后验收。

## 同域名中继与节点管理

补充隔离联调已通过：网关迁移 266、后台节点策略下发、同域名 `/mobile-relay/` 前缀代理、实际 `capacitor://localhost` WebSocket Origin、电脑和手机列表分组。一个在线电脑加一个手机会话的实际统计为 1 / 1 / 3；中继测试另验证一个电脑加两个手机会话为 1 / 2 / 5、超额拒绝、已有传输保留、节点凭据轮换及健康过期过滤。

客户端 22 项测试、正式网页构建和 iOS 模拟器构建通过。中继 101 项测试通过，网关真实 PostgreSQL 及桌面消息链路通过。最新证据保留在同一 `evidence.json`，桌面日志为 `/var/folders/wf/gs6jc_rd4qd_6_1jmqjkg1jh0000gn/T/donebot-verification-evidence/server-1794664870891-75873.log`。

## 手机媒体与列表改进（2026-11-15）

本轮使用独立合成 fixture（端口 5187）和原版隔离运行服务，未操作真实会话。新增 `tests/fixtures/media` 为本地生成的 PNG、MP4、WAV、PDF、TXT 小文件，不含用户媒体。

- `pnpm test`：30 项通过，增加二进制 / chunked 文件内容与 MIME / UTF-8 名称、文件操作白名单、附件格式、仅图发送、重试 ID、切换 Bot 时相机结果归属及退出时中止文件传输。
- `pnpm ios:build`：iOS 模拟器构建通过，包含相机、文件、系统预览 / 分享和保存到“文件”的原生桥与隐私清单。
- 原版 `server/donebot/mobile-host.test.ts`：2 项通过；桌面 `pnpm typecheck` 通过。
- 完整 PostgreSQL 中枢 → 独立中继 → 原版运行服务 → React 客户端传输验证通过：五类文件逐字节一致；重复上传 ID 返回同一路径；原消息未分享文件和私有配置读取被拒绝；保持通知事件与退出撤销检查。
- 完整链路证据位于 DoneBot `.omb-scratch/verify-evidence/mobile-hub/evidence.json`；包含每种文件的 MIME 和字节数。

兼容更新需要新版手机 App，以及包含扩展手机文件路由的桌面 / Cloud 运行服务。网关与独立中继协议不变。相机硬件、iOS 系统保存与分享目标仍需真实 iPhone 验收。


Playwright 实际交互通过：390×844 手机界面的电脑 / Cloud 切换；图片放大后实际解码 480×270；MP4 / WAV 播放元数据正常且无解码错误；PDF 预览及文本内容显示；点击保存下载的 PNG 与源文件 `cmp` 一致；图库选择并发送仅图片消息后，附件草稿清空、原会话显示图片、错误数为 0。320px 宽与系统深色模式检查无横向溢出。修正了新消息浮层挡住附件菜单的问题，并将定时同步与实际新消息提示区分。截图位于 `output/playwright/`。

深色自定义头像复核：实际图片解码宽 480，`filter: none`，主题 midnight，320px 宽无溢出；最后一次 `pnpm ios:build` 通过。

## 直接显示媒体与头像动画复核（2026-11-15）

`pnpm test` 32 项通过；`pnpm ios:build` 再次通过。补充覆盖旧桌面接口拒绝与文件失效的区别，以及原版空值头像字段的解码。图片读取失败不再一律显示手机授权问题。

原版隔离运行服务经 PostgreSQL 中枢和独立中继的完整工作流通过，新增真实 `attach_file` 产生的结构化图片，并逐字节验证手机收到的内容。已登录连接自己的工作空间即可读取 Bot 回复的附件，没有额外的附件授权步骤。本机已安装的桌面包仍是仅支持聊天接口的旧版；修正接口门控的未签名 arm64 安装包位于主仓库 `release/mobile-media-20261115/`，安装包运行服务冒烟和 DMG 校验均通过。

Playwright 合成 fixture 验证：图片直接解码显示且在气泡外，MP4 宽度 480、WAV 时长 1 秒；黑底全屏宽 390px，底部仅有三个操作图标；保存的 PNG 与源文件一致。会话中附件卡片和文字操作栏数量为 0。头像的自定义图片正常显示，空闲造型实际持续变化；系统减少动态效果时停止动画。截图为 `output/playwright/chat-media-direct.png` 和 `output/playwright/media-viewer-dark.png`。

iOS 原生 PDF / Office 预览、保存位置、分享目标与摄像头仍需真机验证；没有部署线上 Cloud、网关或中继，也未替换用户正在运行的桌面程序。

## 持久离线缓存与直接保存图库（2026-11-15）

- `pnpm test`：6 个测试文件、42 项通过。新增覆盖持久存储重新实例化、账号隔离与删除、快照写入失败后重试、无重叠历史合并、Markdown / 引用式附件提取、附件自动缓存、令牌过期后的离线启动、退出时等待写入并丢弃迟到结果，以及图库保存与拒绝权限时的行为。
- `pnpm ios:build`：正式网页、TypeScript、Capacitor 同步和 iOS 模拟器编译通过。原生保存使用 PhotoKit，普通文档仍导出到“文件”。
- 独立 iPhone 17 Pro / iOS 27.2 模拟器调用实际 Filesystem 与媒体插件，写入快照和 900001 字节的分块文件后强制结束 App，再冷启动逐字节校验；账号隔离和仅清理本账号均通过。PNG、MP4、通用 MIME 的 MP4、无扩展名 PNG 均通过实际 PhotoKit 写入图库；无扩展名文件会先按媒体类型补全临时文件扩展名。结果保留在本机 `output/ios-offline-smoke.json`。验证只修改复制的测试 App，独立模拟器已删除。
- Playwright CLI 在独立合成 fixture（端口 5188）、390×844 界面同步后断网，再返回列表并重新打开会话：消息保留，两张图片均解码为 480×270，视频宽度 480、时长 1 秒，音频时长 1 秒，均无媒体解码错误；文本正常显示，PDF 从缓存读出 597 字节和 `%PDF-1.4` 文件头，页面无横向溢出。离线禁止发送，恢复联网后自动回到已连接状态。退出登录后 IndexedDB 条目从 8 降到 0。截图为 `output/playwright/offline-chat-cached.png` 和 `output/playwright/offline-pdf-cached.png`。

缓存范围为已同步到手机的消息页和已完整下载的附件，沿用 100 MB 单文件读取上限。本轮没有在用户真机安装新构建；真机照片权限、图库结果和实际断网 / 冷启动仍需安装新版后验收。

## 主协调 Bot 数据兼容复核（2026-11-15）

原版 `defaultBot` 使用 `{}` 或 `{ person: "成员邮箱" }` 标记主协调 Bot。手机保留该对象并复用原版按账号选择主协调 Bot 的函数，同时兼容旧手机快照中的布尔值。异常数据保留已同步列表并显示可读提示，不直接输出校验 JSON。

- `pnpm test`：7 个测试文件、48 项通过，覆盖对象标记、Cloud 成员选择、旧快照兼容及异常列表恢复。
- `pnpm ios:build`：TypeScript、正式网页构建、Capacitor 同步和 iOS 模拟器编译通过。
- PostgreSQL 中枢、独立中继与原版隔离运行服务联调通过；真实列表和历史响应由手机正式 schema 解析，并检查原版自动创建的主协调 Bot 对象标记。
- Playwright CLI 在 390×844 合成 fixture 中确认列表已连接、主协调 Bot 居中、部门与群聊可见、发送后收到回复、切换 Cloud 后显示对应主协调 Bot，页面无校验错误。截图：`output/playwright/default-bot-fixed.png`。

此次兼容修复只需更新手机 App，无需因此更新网关、中继或桌面安装包；尚未安装到用户真机。

## 菜单、设置与自动化开关（2026-11-15）

- `pnpm test`：7 个文件、53 项通过。增加工作空间隔离、公共应用状态解码、三类自动化开关、仅发送 enabled、离线拒绝、失败保留状态、轮询旧响应与退出后的迟到结果检查。
- 桌面相关 4 个测试文件、94 项通过；服务端 TypeScript 检查通过。覆盖 client 路由、可见 Bot 范围、严格布尔请求体、额外内容字段拒绝和 webhook 凭据不泄露。
- `pnpm ios:build`：正式网页、Capacitor 同步和 iOS 模拟器编译通过。
- 临时 PostgreSQL 中枢、独立中继与原版隔离运行服务联调通过：读取三类自动化接口和应用状态，手机开关回写原版定时工作与 webhook；确认指令内容保持不变，夹带内容修改被拒绝。证据保留在 DoneBot `.omb-scratch/verify-evidence/mobile-hub/evidence.json`。
- Playwright CLI 在 390×844 合成 fixture 验证菜单 / 设置导航、密度选择、公共应用连接状态、电脑与 Cloud 切换、三类开关刷新后的状态。在线只显示标题绿点；主协调头像缩小；工具活动和执行摘要从会话隐藏。截图位于 `output/playwright/menu-settings.png`、`menu-automations.png`。
- 刷新网页并重新登录后密度选择保留，宽松列表实测行高 94px、主协调头像 60px；320×568 深色列表和会话无横向溢出，浏览器没有 error / warning。截图为 `output/playwright/menu-directory-narrow-dark.png`、`menu-chat-narrow-dark.png`。

本功能需要更新手机 App 和桌面 / Cloud 运行服务。网关与独立中继协议不变，无需因此更新网关或中继镜像；未部署线上服务或安装到用户真机。

## 手机附件传入模型（2026-11-15）

图片上传和原会话保存成功后，桌面统一网关接入曾把缺失的可选 `input_modalities` 误判为不支持图片，导致模型请求丢失图片。修复位于相邻 DoneBot 项目的 `server/donebot/runtime-host.ts`，沿用原版 driver 的图片输入能力，所有网关模型均按支持多模态输入处理。

四种模型接口的传图回归检查与目录检查共 44 项通过；临时 PostgreSQL 中枢 → 独立中继 → 原版隔离 Desktop / Cloud 运行服务的完整流程均通过。修复前原生模型请求的图片输入为 0，修复后为 1，且内容与手机上传原图逐字节一致。验证使用合成模型响应，未调用真实收费模型。完整证据与日志见 DoneBot `docs/verification/donebot-mobile.md` 的对应记录。

此问题需升级桌面或 Cloud 运行服务后生效，手机 App 无需为这次修复重新打包。包含修复的本机 arm64 桌面测试包位于 DoneBot `release/mobile-input-20261115/`；未安装到用户电脑，也未部署线上 Cloud。

## 在线状态自动刷新与推送恢复（2026-11-15）

- `pnpm test`：8 个文件、65 项通过，覆盖恢复登录后自动发现、手机心跳阻塞时仍能读列表、不同工作空间独立刷新、旧响应不覆盖离线或重新连接后的状态、前后台切换及原生生命周期初始状态竞态。
- 后台模拟检查：前台轮询停止、不新建消息请求、不注销 APNs；返回前台会重建连接并读取离开期间的新消息。旧历史请求失败不会关闭新连接。系统撤销通知授权后不会自动重新授权。
- 订阅恢复检查：用户已授权且网关绑定失败时保留开启意愿；网络恢复立即重试，持续前台时至少相隔 60 秒重试；成功绑定后不持续重复注册。
- `pnpm ios:build`：TypeScript、正式网页构建、Capacitor 同步及 iOS 模拟器编译通过。构建日志：`/tmp/donebot-mobile-refresh-ios-20261115.log`。
- Playwright CLI 驱动 390×844 独立合成 fixture；暂停网页计时器后切换到离线 Cloud、电脑、恢复在线的 Cloud，三次操作分别立即请求工作空间列表并更新状态，未点击手动刷新。页面使用正式加密协议；状态响应为本轮浏览器拦截的合成数据。截图：`output/playwright/auto-refresh-cloud.png`。
- 网关原有 `TestPostgresOwnershipGrantsAndPush` 在本轮临时 PostgreSQL 中重新通过，覆盖无需手机心跳的推送目标绑定与持久队列、投递重试、无效 token 和撤销。本轮未修改网关服务或生产数据，发送器为合成 APNs，不代表 Apple 接收或真机送达。

本轮只需更新手机 App。没有安装到用户真机，没有执行网关、中继或 Cloud 线上升级。系统后台任务不提供固定刷新频率，提醒继续由网关发送 APNs alert；真实签名安装包仍需检查后台、锁屏、退出后送达及通知跳转。

## 导航与媒体预览手势（2026-11-15）

统一取消按钮、链接、输入框与选择器的焦点外框和触摸高亮；返回箭头保持 44px 点击区域，按下时不出现圆形背景。聊天、菜单、设置及其子页面支持左滑返回上一级。媒体预览支持下滑、左滑、点击空白或 Esc 退出；图片支持 1–4 倍双指缩放、缩放后的单指拖动及双击放大 / 还原。缩放中的拖动不触发关闭，缩回原尺寸后重新居中；表单、文本选择、横向滚动区域及媒体控制条保留原操作。

- `pnpm test`：9 个文件、70 项通过，包括手势方向与误触、图片适配、焦点缩放位置和边界限制的 5 项新增检查。
- `pnpm ios:build`：正式网页与 TypeScript 构建、Capacitor 同步和 iOS 模拟器编译通过。日志为 `output/gestures-ios-build.log`。
- Playwright CLI 的 Chromium 390×844 独立合成 fixture 通过真实触摸输入检查左滑返回、双指缩放至约 2.57 倍、放大后拖动、缩回原尺寸、双击切换、取消多指、空白和下滑关闭。保存按钮触发 PNG 下载，视频控件操作保留预览，视频下滑和音频空白关闭正常，退出预览后仍留在原聊天。证据为 `output/playwright/gestures-navigation-check.log` 和 `gestures-preview-check.log`。
- WebKit 的 iPhone 尺寸与触摸模式确认电脑 / Cloud 选择器、菜单关闭和设置返回均无焦点外框，实际触摸单击图片不关闭、双击放大到 2.5 倍、空白关闭正常；320×568 深色界面无横向溢出。证据为 `output/playwright/gestures-webkit-check.log`，截图包括 `gesture-webkit-picker.png`、`gesture-webkit-menu.png`、`gesture-webkit-settings.png`、`gesture-webkit-zoom.png`、`gesture-webkit-narrow-dark.png`。

Chromium 检查没有控制台错误。Playwright WebKit 在加载合成音视频时报告其内置媒体控件图标资源错误，以上 WebKit 结果仅用于外框、图片触摸与布局检查，不作为真机音视频兼容性证明。

以上均为独立合成数据与浏览器触摸检查，未安装到用户真机。此轮仅需更新手机 App，无需更新桌面或线上服务。

## 部门折叠、未读条数与工作状态（2026-11-15）

部门标题支持展开和折叠，状态按账号、电脑 / Cloud 和部门分别保存；搜索期间临时展示匹配成员，清除搜索后恢复折叠状态。部门负责人稳定排在成员列表第一位。折叠时右侧汇总实际未读消息条数，展开时各 Bot 显示红点；主协调 Bot 和普通 Bot 均独立显示工作绿点，可与红点同时存在。设置页通过按钮、Esc 或左滑返回时直接回到聊天主界面。

未读条数复用原版任务的 unread、lastReadMessageId、updatedAt 和只读消息分页接口，在手机端跨页计算；排除用户消息、工具活动、执行摘要、屏幕和压缩事件。查询不调用 read 接口；打开一个会话保留同 Bot 其他会话的未读状态。相同未读范围复用结果，无更新元数据的其他会话每 30 秒重新计算；计算中或无法定位已读位置时显示省略号，不把不完整历史当作准确条数。补取的消息页和计算结果进入账号离线缓存。

- `pnpm test`：10 个文件、79 项通过。新增检查覆盖跨多页未读、多个任务与群聊汇总、读标记变化、工作空间隔离、缓存复用、缺失读标记、失败重试、迟到结果与退出后的账号隔离。日志：`output/departments-tests.log`。
- `pnpm ios:build`：TypeScript、正式网页构建、Capacitor 同步与 iOS 模拟器编译通过。日志：`output/departments-ios-build.log`。
- 通过 `MOBILE_FIXTURE_PORT=5192 MOBILE_ATTENTION_FIXTURE=1 pnpm dev:fixture` 启动独立合成数据。普通成员刻意排在负责人之前，验证显示顺序仍为负责人、小林、群聊。小林的历史包含 65 条消息，已读位置为第 5 条，未读 60 条；部门初始汇总为 63，阅读小鹿后为 61，阅读小林并收到新回复后为 2。查询统计不消除其他会话的红点，工作结束后绿点消失。
- Chromium 在 390×844 验证红绿点同时显示及实际颜色、折叠后隐藏成员、刷新保存、搜索临时展开、Cloud 同名部门隔离、数量变化和设置按钮 / Esc 返回。真实触摸输入验证设置左滑后无菜单残留。证据：`output/playwright/departments-check.log`、`departments-settings-swipe.log`。
- WebKit 的手机触摸模式验证负责人置顶、主协调红绿点、点按折叠、搜索恢复、设置点按返回，以及 320×568 深色无溢出、44px 点击区域和无焦点外框。证据：`output/playwright/departments-webkit-check.log`。截图包括 `departments-expanded.png`、`departments-unread-63.png`、`departments-narrow-dark.png`、`departments-webkit-dark.png`，均在 `output/playwright/`。

此轮只修改手机项目，需重新打包安装手机 App。未安装到用户真机，未修改桌面原版服务或部署线上服务。

## 桌面与 Cloud Bot 表情协议一致性（2026-11-15）

桌面与 Cloud 的同一运行服务在 Bot 列表中发送 `mascotExpression` 状态名称（例如 `proud`、`happy`、`focused`），也可能发送 null 或省略。手机此前仅允许数字，导致带命名表情的列表整体校验失败，显示“收到的数据暂不兼容”。此修复不把该提示当作网络故障证据，也不推断生产 Cloud 使用了哪一版镜像。

手机从 DoneBot 的 `shared/bot-avatar.ts` 同步表情校验约定，并从桌面 `src/lib/mascot.ts` 同步 `normalizeState` 及旧名称映射；两种头像都使用同一状态映射。已有数字缓存保留读取兼容性。`node scripts/sync-avatars.mjs` 或 `pnpm sync:desktop` 可重复生成共享文件。

检查命令（隔离检查需同级 DoneBot 源码和依赖）：

```sh
pnpm test
node --experimental-strip-types scripts/verify-desktop-contract.ts
pnpm ios:sync
```

82 项手机测试通过，覆盖完整目录解析、表情名称与旧名称、缓存恢复，以及模拟手机同时读取电脑和 Cloud 时保持在线。真实隔离 DoneBot 运行服务通过原版 HTTP 路由保存四种表情，再用生产手机校验器读取 `/api/bots?messages=20`，所有 Bot 均保留，表情映射正确。证据位于临时目录 `donebot-mobile-contract-QSn31t/receipt.json`，服务日志由脚本输出。生产构建和 Capacitor iOS 资源同步通过；未操作用户账号、部署实例或物理手机，真机需安装更新后的 App。


## 大文件持续传输与附件交互（2026-11-16）

生产中继协议的隔离测试覆盖持续 250 秒视频下载与并发 Bot 查询，传输有进度不超时；
连续 180 秒没有文件进度仅取消该请求，加密连接继续可用，30 秒完全静默的链路仍检测断开。
公网 URL 下载也使用 180 秒无进度超时，合成流持续 300 秒可完整结束；停滞不退出账号或关闭工作空间。
文件仍遵守 100 MB 上限，退出账号会取消进行中的传输，切换页面不会中止共享下载。

`pnpm test` 共 12 文件 90 项通过，`pnpm build`、Capacitor 同步、iOS 模拟器及真机目标编译通过。
通过独立 `MOBILE_FIXTURE_PORT=5190 pnpm dev:fixture` 与真实 Chromium 输入，验证相机／图库／本地
PDF 文件入口、发送和原会话回执、视频 480×270／1 秒解码、全屏黑底及三个操作图标、电脑／Cloud
切换、左边缘右滑返回列表及纵向滚动不误返回。390×844 与 320×568 深色无横向溢出，菜单按钮
高度 44px，输入与发送控件均在视口内。截图保留在 `output/playwright/*20261116.png`。

浏览器相机测试使用文件选择器注入合成照片；未实际拍摄。真机系统文件、保存／分享目标和相机硬件、
公网慢速连接、后台 APNs 送达仍需设备验证。本次没有操作用户的线上设备或部署生产实例。

## 手机 Bot 对话列表（2026-11-16）

手机继续使用原有 `/api/bots?messages=20`、线程消息和已读接口，读取对话名称与更新时间。
默认进入未归档对话中最后收到 Bot 回复的那一段，列表预览也采用该回复；较新的用户消息、
工具活动与执行摘要不改变选择。图片等仅含附件的 Bot 回复同样参与比较。
右上角的盾标替换为对话入口，其他对话有未读消息时显示红点；列表区分当前、未读与归档对话。
手机切换时固定线程，草稿、附件和发送目标分别保留，不调用桌面的对话选择接口。
摘要按线程更新时间复用缓存，需要时向前分页定位回复；读取失败可重试，离线仍可查看已缓存内容。

- `pnpm test`：13 个文件、99 项通过，覆盖最新 Bot 回复选择、附件回复、分页查找、缓存复用、
  独立发送与草稿、其他对话未读、通知指定线程、失败重试、离线恢复及切后台／退出时的迟到响应。
- `node --experimental-strip-types scripts/verify-desktop-contract.ts`：启动原版隔离运行服务及 fake engine，
  创建非当前对话后，使用手机相同的 HTTP 请求发送、收到回复并标记已读；读取真实目录经手机校验后，
  默认选中该对话，桌面选择仍保持原线程。回执保存在本机临时目录 `donebot-mobile-contract-3ZBl7V/receipt.json`。
- `MOBILE_CONVERSATIONS_FIXTURE=1 MOBILE_FIXTURE_PORT=5191 pnpm dev:fixture`：通过 Playwright CLI
  在 393×852、320×568 实际浏览器中验证电脑与 Cloud 的默认对话、对话列表、另一个线程收到回复后
  自动出现红点、进入对应线程后红点清除，以及 Cloud 非当前线程的加密发送与回复。
  320px 页面和列表均无横向溢出，对话入口为 44px；浏览器无 error 或 warning。
  截图保存在 `output/playwright/conversation-*-20261116.png`。
- `pnpm ios:build`：生产 TypeScript / Vite 构建、Capacitor iOS 资源同步与模拟器编译通过。

此次仅修改手机工程。推送规则按用户选择暂不修改，桌面运行服务、Cloud 镜像、网关和中继无需为此更新。
未安装到用户的物理手机，未部署线上服务；需更新手机 App 才会使用新的对话列表。

## 2026-11-17：预览与下载断点续传

本机与 Cloud 附件共用 1 MiB 分段下载，按 Range、If-Range 和强 ETag 检查文件版本，并在全部接收后复查版本。网络中断或单个流连续 180 秒无进展会自动重试，连续失败最多重试五次后保留断点供手动续传。进入后台或离线时等待恢复；App 重启后再次打开附件可使用持久断点，完整缓存提交成功才删除断点。图片、视频、音频、PDF/其他文档使用同一入口。无强版本校验的外部服务和旧服务退回完整下载，100 MiB 上限保持。

手机测试覆盖本机/Cloud 四类媒体重连、前后台、持久断点、版本变化、权限拒绝、原生磁盘清单中断、存储不足、慢传输和有界重试。15 个测试文件共 131 项通过，TypeScript 和修改文件的 oxlint 检查通过。`pnpm ios:build` 完成模拟器构建，日志在 `.build-resumable-ios.log`。

桌面仓库新增 `server/message-file-range.e2e.test.ts`。网关隔离集成流程通过真实独立中继主动打断四类超过 2 MiB 的下载，重新建连后从第二段续传，结果逐字节相同。完整运行方式和证据说明见同级 DoneBot 的 `docs/verification/mobile-file-resume.md`。需要更新手机 App 和文件来源的运行服务；未安装到用户手机，也未更新线上 Cloud。
