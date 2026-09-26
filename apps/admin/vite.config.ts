import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * 后台 SPA 构建配置（`docs/03` §3.5.2）。
 *
 * - 本地开发/预览：把 `/api/*` 代理到 `wrangler dev`（`apps/api` 默认 8787 端口）。
 * - 生产：**不使用任何公网绝对 URL**——`/api/*` 由本 Worker 用 Service Binding
 *   同源转发到 `dshop-api`（`docs/04` §4.1），HttpOnly Cookie 因此保持同源。
 * - 静态资产由 Workers Assets 托管（SPA fallback）。
 */
const API_PROXY_TARGET = "http://127.0.0.1:8787";

const apiProxy = {
  "/api": {
    target: API_PROXY_TARGET,
    changeOrigin: true,
  },
} as const;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: apiProxy,
  },
  preview: {
    port: 5174,
    proxy: apiProxy,
  },
});
