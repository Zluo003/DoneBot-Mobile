# iOS 工程

应用 ID：`cn.donebot.mobile`。原生工程：`ios/App/App.xcodeproj`，Scheme：`App`。当前使用 Capacitor 8，应用最低 iOS 16.4。

```sh
pnpm ios:sync
pnpm ios:open
```

在 Xcode 的 Signing & Capabilities 选择自己的 Apple Developer Team，并确认该 App ID 启用 Push Notifications。未写入 Team ID、证书、密码或 APNs 密钥。模拟器构建命令 `pnpm ios:build` 不需要真实开发者身份。

Debug 使用 `development` APNs entitlement 与 `sandbox` token 环境；Release 使用 `production` / `production`。`App.entitlements` 和 `Info.plist` 从对应构建变量取值。真机和 TestFlight 的通知必须分别验证，不应以模拟器构建成功代替送达验证。

`DoneBotViewController` 注册本地 `DoneBotVault` Capacitor 插件。`SceneDelegate` 必须实例化该控制器。Keychain 项使用 `WhenUnlockedThisDeviceOnly`，不写入 Web Storage；读取不到存储时明确要求重新登录。APNs token 由原版 Capacitor 插件接收，AppDelegate 转发系统注册回调。

已经适配安全区域、系统深浅色、原生键盘缩放和横屏 / 平板布局。登录页保留单个主 Logo。图标和启动图使用当前桌面品牌素材。

上架前必须接通 `docs/mobile-api.md` 的正式服务、配置真实签名，并用真实设备完成登录、跨网络连接、后台消息提醒和通知冷启动检查。当前工程可作为首版客户端继续开发，尚不是已连通正式中枢的可发布版本。
