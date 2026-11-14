import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command, mode }) => {
  if (command === "build" && mode === "production" && process.env.MOBILE_FIXTURE_ORIGIN) {
    throw new Error("隔离验证服务不能进入正式构建。");
  }
  return {
    plugins: [react()],
    define: { __FIXTURE__: JSON.stringify(mode === "fixture") },
    server: {
      host: "127.0.0.1",
      watch: { ignored: ["**/ios/**", "**/.build/**", "**/output/**", "**/.playwright-cli/**"] },
      proxy: process.env.MOBILE_FIXTURE_ORIGIN ? {
        "/api/": { target: process.env.MOBILE_FIXTURE_ORIGIN },
        "/fixture-relay/": { target: process.env.MOBILE_FIXTURE_ORIGIN, ws: true },
      } : undefined,
    },
    build: { target: "es2022" },
  };
});
