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

const apiProxy = {
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
