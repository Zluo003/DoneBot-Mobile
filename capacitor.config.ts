import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "cn.donebot.mobile",
  appName: "DoneBot",
  webDir: "dist",
  loggingBehavior: "none",
  ios: { contentInset: "never", preferredContentMode: "mobile", backgroundColor: "#fcfcfc" },
  plugins: {
    CapacitorHttp: { enabled: true },
    PushNotifications: { presentationOptions: [] },
    Keyboard: { resize: "native", resizeOnFullScreen: true },
  },
};
export default config;
