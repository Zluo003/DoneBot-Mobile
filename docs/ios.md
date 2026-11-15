# iOS 工程

应用 ID：`cn.donebot.mobile`。原生工程：`ios/App/App.xcodeproj`，Scheme：`App`。当前使用 Capacitor 8，应用最低 iOS 16.4。

```sh
pnpm ios:sync
pnpm ios:open
```

在 Xcode 的 Signing & Capabilities 选择自己的 Apple Developer Team，并确认该 App ID 启用 Push Notifications。工程保留当前开发者 Team 配置，不写入证书、密码或 APNs 私钥。模拟器构建命令 `pnpm ios:build` 不需要真实开发者身份。

Debug 使用 `development` APNs entitlement 与 `sandbox` token 环境；Release 使用 `production` / `production`。`App.entitlements` 和 `Info.plist` 从对应构建变量取值。开发签名真机无需上架就能使用 APNs；网关须在「DoneBot → 手机连接」上传 .p8 并填写 Apple Key ID / Team ID。真机和 TestFlight 的通知必须分别验证，不应以模拟器构建成功代替送达验证。

`DoneBotViewController` 注册本地 `DoneBotVault` Capacitor 插件。`SceneDelegate` 必须实例化该控制器。Keychain 项使用 `WhenUnlockedThisDeviceOnly`，不写入 Web Storage；读取不到存储时明确要求重新登录。APNs token 由原版 Capacitor 插件接收，AppDelegate 转发系统注册回调。

已经适配安全区域、系统深浅色、原生键盘缩放和横屏 / 平板布局。登录页保留单个主 Logo。图标和启动图使用当前桌面品牌素材。

上架前必须接通 `docs/mobile-api.md` 的正式服务、配置真实签名，并用真实设备完成登录、跨网络连接、后台消息提醒和通知冷启动检查。当前工程可作为首版客户端继续开发，尚不是已连通正式中枢的可发布版本。


## 照片与文件

`pnpm ios:sync` 会同步 Camera、Filesystem、FileViewer 和 Share 插件及 SPM 依赖。Info.plist 已包含相机、图库与照片写入用途说明；`PrivacyInfo.xcprivacy` 声明 Filesystem 所需文件时间戳用途 C617.1。

`DoneBotViewController` 同时注册 `DoneBotDocuments`。图片、视频预览中的保存按钮调用 `saveToPhotos`，用 PhotoKit 的 `addOnly` 权限和 `PHAssetCreationRequest` 直接写入图库；拒绝权限或不支持的媒体格式会显示明确提示，不转为文件位置选择。普通文档通过 `UIDocumentPickerViewController(forExporting:asCopy:)` 保存到用户选择的“文件”位置。桥只接受 DoneBot 临时媒体目录内的文件。文档预览使用系统文件预览，转发使用系统分享菜单。

## 离线缓存

已同步的 Bot 列表、各会话已加载的历史和附件存于 `Filesystem.Directory.LibraryNoCloud` 下的 `donebot-offline-v1`，按账号摘要分目录。该位置持久保留且排除 iCloud 备份，与系统可清理的临时媒体目录分离；启动、预览结束或普通后台恢复不会删除这些缓存。会话凭据仍只保存在 Keychain，不写入缓存快照。

启动先恢复本机数据，随后联网刷新；access token 过期不会阻止离线读取，实际网络请求仍先刷新令牌。附件按账号、工作空间、Bot、会话、消息和路径隔离，后台最多两个下载；同时提取消息附件、原版附图标记和 Markdown 图片 / 文件链接（包含引用式链接），无需逐个点开才缓存。历史消息只缓存已经同步到手机的页面，尚未下载完成的文件和超过现有 100 MB 单文件上限的附件不能离线打开。

文件按块写入，完整写入后才提交元数据；启动优先恢复快照，写入中断时可回退到上次快照。退出登录等待已开始的写入后删除该账号的缓存，并丢弃迟到的下载结果；不会删除用户已导出到图库或“文件”的副本。浏览器预览使用独立的 IndexedDB 缓存，浏览器登录状态仍只保留在内存。

真机验收还需覆盖：首次授权 / 拒绝相机与图库、取消选择、有限照片权限、仅图发送、后台恢复；PDF / Office 预览、图片放大、音视频播放、保存到本机 / iCloud Drive、分享至已安装应用。模拟器编译与浏览器检查不代表这些原生操作已完成真机验收。
