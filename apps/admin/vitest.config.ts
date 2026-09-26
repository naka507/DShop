import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * 单测配置（与 `vite.config.ts` 分离，避免把 vitest 类型带进构建配置）。
 *
 * - 环境 `jsdom`：React 组件测试需要 DOM（antd 5 需要 `matchMedia` / `ResizeObserver`，
 *   由 `tests/setup.ts` 补齐）。
 * - `tests/setup.ts` 统一 stub `fetch`，避免用例打到真实网络。
 * - `testTimeout` 放宽到 20s：antd 组件树在 jsdom 下首渲染较慢，
 *   默认 5s 在并发跑多个测试文件时会偶发超时（用例本身并未卡死）。
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    setupFiles: ["./tests/setup.ts"],
    testTimeout: 20_000,
  },
});
