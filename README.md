# DoneBot Mobile

React + TypeScript + Capacitor 的 iOS 客户端。UI 沿用 DoneBot 桌面端 Daylight / Midnight 主题、Geist 字体和品牌素材。

首版范围：账号登录（含现有账号的二次验证）、电脑 / 已开通 Cloud 的 Bot 列表、查看和发送文本消息、新消息推送设置与通知跳转。手机不创建 Bot、开通 Cloud、充值或配置模型。

## 当前状态

- 客户端和 iOS 工程已实现，可以编译到模拟器。令牌存于 iOS Keychain，密码不落盘。
- 登录对接 `https://donebot.cn` 的现有账号接口。
- 消息层使用原版 Noise / yamux 加密协议和原版 Bot / thread API；已通过协议向量和隔离桌面实例验证。
- 已同步的 Bot 列表、会话消息和附件按账号持久保存在手机；离线或重启后仍可查看。图片和视频可直接保存到手机图库，文档保存到“文件”。附件在同步后后台下载，未完成的下载会在恢复联网后重试；退出登录会清除此账号的本机缓存。
- 网关已实现工作空间发现、按登录会话授权、桌面确认、推送订阅和持久通知队列；桌面/Cloud 连接器复用原版会话和自建中继。完整隔离消息链路已通过，正式公网服务尚未部署。
- 默认中继地址为 `donebot.cn/mobile-relay`，复用现有 HTTPS 域名，不要求新建 DNS；后台管理候选节点并自动下发，手机不需要扫描桌面旧版二维码。网关个人资料页分别显示电脑和手机登录状态。
- 已实现 iOS 通知授权、APNs token 注册、绑定接口调用、退出撤销、账号与会话校验。真实后台通知送达尚未验证，不能用前台轮询替代 APNs。
- 按用户授权修改了桌面运行服务与网关；Cloud 运行服务发布后复用相同连接器。没有修改 Cloud 的资源/磁盘配置，也没有执行线上部署。

## 本地开发

需要 Node.js 24+、pnpm 10；iOS 构建需要 Xcode。

```sh
pnpm install
pnpm dev:fixture
```

访问 `http://127.0.0.1:5174`。合成账号为 `preview@donebot.test`，密码 `donebot-preview`。这些凭据只在内存夹具中有效；测试不接触真实账号、Bot 或用户资料。网页预览不提供系统推送，登录状态只保存在内存中。

```sh
pnpm test
pnpm build
pnpm ios:build
pnpm ios:open
```

`ios:build` 生成模拟器构建并使用本机临时签名；真机和归档需在 Xcode 配置自己的 Apple Team。应用标识为 `cn.donebot.mobile`。

## 桌面复用与平台接口

`pnpm sync:desktop` 从同级 `DoneBot` 同步品牌、两套主题和协议源码，保留原版授权声明；仅将 Node 密码原语替换为浏览器实现。应用构建和运行不依赖同级工程，隔离夹具和同步命令需要它。

`src/platform/index.ts` 提供安全存储、推送、通知点击和应用恢复的适配层。Android 可沿用 React 页面与 Capacitor 工程模式，但其安全存储 / FCM 适配尚未实现。原生 HarmonyOS 需单独实现系统容器和 Push Kit / 安全存储适配；目前只预留契约，不能直接编译为原生鸿蒙应用。

登录页顶部重复品牌栏已移除，保留一个主 Logo。

详见 [中枢接口](docs/mobile-api.md)、[iOS 配置](docs/ios.md)、[验证记录](docs/verification.md)。
