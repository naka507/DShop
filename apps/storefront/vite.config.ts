/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * storefront 构建配置（`docs/03-工程结构与前端.md` §3.5）。
 *
 * ## 同源转发铁律（`docs/09-认证权限与部署.md` §10.2 / `docs/04` §4.1）
 *
 * 前端**一律使用相对路径** `/api/v1/*`：
 * - dev / preview：由本文件的 Vite 代理转到本地 API（`wrangler dev`，默认 8787）；
 * - 生产：由 storefront Worker 用 Service Binding 同源转发到 `dshop-api`。
 *
 * **绝不用公网绝对 URL fetch** —— 同 zone 的子请求会把 Host 头绕回发起方自己，
 * 实测表现为静默 404。
 */
const API_TARGET = "http://127.0.0.1:8787";

/**
 * PiEcho 智能客服网关（本地联调）。
 *
 * C 端客服窗口归 DShop（`docs/11` §14.1 / §15 Q11）。PiEcho 网关的 CORS **已实现但
 * 默认关闭**（配置门控），且「同域反代 vs 直连 + CORS」的形态**尚未定案**（R24 ②），
 * 因此当前必须与商城 API 一样走**同源反代**：本地由这里代理到 PiEcho 网关
 * （`npm --workspace @piecho/server run start`，默认 8788），生产走 Service Binding。
 *
 * ⚠️ 键的顺序即匹配顺序（Vite 按前缀逐条比对，**先匹配先命中**）：
 * 这六条必须排在下面的 `/api` 之前，否则会被 `/api` 吞掉转去 DShop API（8787）。
 * 两组路径本身不冲突（DShop 用 `/api/v1/{shop,admin,merchant,agent,callbacks}`，
 * PiEcho 用 `/api/v1/{chat,sessions,handover,tickets,auth,health}`）。
 */
const SUPPORT_TARGET = "http://127.0.0.1:8788";

const supportProxy = {
  "/api/v1/chat": { target: SUPPORT_TARGET, changeOrigin: false },
  "/api/v1/sessions": { target: SUPPORT_TARGET, changeOrigin: false },
  "/api/v1/handover": { target: SUPPORT_TARGET, changeOrigin: false },
  "/api/v1/tickets": { target: SUPPORT_TARGET, changeOrigin: false },
  "/api/v1/auth": { target: SUPPORT_TARGET, changeOrigin: false },
  "/api/v1/health": { target: SUPPORT_TARGET, changeOrigin: false },
};

const apiProxy = {
  ...supportProxy,
  "/api": {
    target: API_TARGET,
    changeOrigin: false,
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: apiProxy,
  },
  // `vite preview` 同样代理，便于本地以"生产构建产物"联调（生产由 Worker 转发）。
  preview: {
    port: 4173,
    proxy: apiProxy,
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    setupFiles: ["./tests/setup.ts"],
    restoreMocks: true,
  },
});
