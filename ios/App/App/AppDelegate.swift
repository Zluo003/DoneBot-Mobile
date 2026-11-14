import UIKit
import Capacitor
import Security

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}

@objc(DoneBotViewController)
class DoneBotViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(DoneBotVaultPlugin())
    }
}

@objc(DoneBotVaultPlugin)
class DoneBotVaultPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "DoneBotVaultPlugin"
    let jsName = "DoneBotVault"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pushEnvironment", returnType: CAPPluginReturnPromise)
    ]
    private let service = "cn.donebot.mobile.vault"

    private func query(_ call: CAPPluginCall) -> [String: Any]? {
        guard let key = call.getString("key"), !key.isEmpty, key.count <= 500 else {
            call.reject("Invalid secure storage key")
            return nil
        }
        return [kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: key]
    }

    @objc func read(_ call: CAPPluginCall) {
        guard var query = query(call) else { return }
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { call.resolve(["value": NSNull()]); return }
        guard status == errSecSuccess, let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
            NSLog("DoneBot secure storage status: %d", status)
            call.reject("Secure storage unavailable")
            return
        }
        call.resolve(["value": value])
    }

    @objc func write(_ call: CAPPluginCall) {
        guard let query = query(call), let value = call.getString("value"), let data = value.data(using: .utf8), data.count <= 131072 else {
            call.reject("Invalid secure storage value")
            return
        }
        let attributes: [String: Any] = [kSecValueData as String: data,
                                      kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            attributes.forEach { item[$0.key] = $0.value }
            guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else {
                call.reject("Could not save secure storage")
                return
            }
        } else if status != errSecSuccess {
            call.reject("Could not update secure storage")
            return
        }
        call.resolve()
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let query = query(call) else { return }
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            call.reject("Could not clear secure storage")
            return
        }
        call.resolve()
    }

    @objc func pushEnvironment(_ call: CAPPluginCall) {
        guard let environment = Bundle.main.object(forInfoDictionaryKey: "DoneBotPushEnvironment") as? String,
              environment == "sandbox" || environment == "production" else {
            call.reject("Push environment missing")
            return
        }
        call.resolve(["environment": environment])
    }
}
