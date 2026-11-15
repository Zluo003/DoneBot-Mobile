import { nativeMedia, webMedia } from "./media";
import { nativeOfflineStorage, webOfflineStorage } from "./cache";
import { Capacitor, registerPlugin } from "@capacitor/core";
import { App } from "@capacitor/app";
import { PushNotifications } from "@capacitor/push-notifications";
import { notificationRouteSchema, type Platform, type PushRegistration } from "../core/contracts";

interface NativeVault {
  read(options: { key: string }): Promise<{ value: string | null }>;
  write(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
  pushEnvironment(): Promise<{ environment: "sandbox" | "production" }>;
}
const keychain = registerPlugin<NativeVault>("DoneBotVault");
const memory = new Map<string, string>();
let extension: Platform | undefined;

export function registerPlatform(platform: Platform): void { extension = platform; }

const web: Platform = {
  kind: "web", media: webMedia, cache: webOfflineStorage,
  vault: {
    read: async key => memory.get(key) ?? null,
    write: async (key, value) => { memory.set(key, value); },
    remove: async key => { memory.delete(key); },
  },
  push: {
    permission: async () => "unavailable",
    register: async () => { throw new Error("请在手机 App 中开启消息提醒。"); },
    unregister: async () => {}, onOpen: async () => () => {}, onReceive: async () => () => {},
  },
  onResume: async listener => {
    const resume = () => { if (!document.hidden) listener(); };
    document.addEventListener("visibilitychange", resume);
    return () => document.removeEventListener("visibilitychange", resume);
  },
};

const ios: Platform = {
  kind: "ios", media: nativeMedia, cache: nativeOfflineStorage,
  vault: {
    read: async key => (await keychain.read({ key })).value,
    write: async (key, value) => keychain.write({ key, value }),
    remove: async key => keychain.remove({ key }),
  },
  push: {
    permission: async () => {
      const permission = await PushNotifications.checkPermissions();
      return permission.receive === "prompt-with-rationale" ? "prompt" : permission.receive;
    },
    register: async () => {
      let permission = await PushNotifications.checkPermissions();
      if (permission.receive === "prompt") permission = await PushNotifications.requestPermissions();
      if (permission.receive !== "granted") throw new Error("消息提醒未开启，可以在系统设置中允许通知。");
      return new Promise<PushRegistration>((resolve, reject) => {
        const cleanups: Array<() => Promise<void>> = [];
        let settled = false;
        const finish = (value: PushRegistration | Error) => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          void Promise.all(cleanups.map(remove => remove()));
          if (value instanceof Error) reject(value); else resolve(value);
        };
        const timer = setTimeout(() => finish(new Error("通知注册超时，请稍后重试。")), 20_000);
        void (async () => {
          const registered = await PushNotifications.addListener("registration", token => {
            void keychain.pushEnvironment().then(({ environment }) => finish({ token: token.value, platform: "ios", environment }), () => finish(new Error("无法读取推送环境。")));
          });
          cleanups.push(() => registered.remove());
          const failed = await PushNotifications.addListener("registrationError", event => {
            const signing = /aps-environment|entitlement/i.test(event.error);
            finish(new Error(signing ? "此安装包未获得 Apple 推送授权，请使用启用 Push Notifications 的签名重新安装。" : "暂时无法向 Apple 注册消息提醒，请检查网络后重试。"));
          });
          cleanups.push(() => failed.remove());
          if (settled) { await Promise.all(cleanups.map(remove => remove())); return; }
          await PushNotifications.register();
        })().catch(() => finish(new Error("暂时无法注册消息提醒。")));
      });
    },
    unregister: async () => { await PushNotifications.unregister(); await PushNotifications.removeAllDeliveredNotifications(); },
    onOpen: async listener => {
      const handle = await PushNotifications.addListener("pushNotificationActionPerformed", event => {
        const parsed = notificationRouteSchema.safeParse(event.notification.data);
        if (parsed.success) listener(parsed.data);
      });
      return () => { void handle.remove(); };
    },
    onReceive: async listener => {
      const handle = await PushNotifications.addListener("pushNotificationReceived", listener);
      return () => { void handle.remove(); };
    },
  },
  onResume: async listener => {
    const handle = await App.addListener("appStateChange", ({ isActive }) => { if (isActive) listener(); });
    return () => { void handle.remove(); };
  },
};

export function platform(): Platform {
  if (extension) return extension;
  const kind = Capacitor.getPlatform();
  if (kind === "ios") return ios;
  if (kind === "web") return web;
  throw new Error("当前平台尚未安装系统适配器。");
}
