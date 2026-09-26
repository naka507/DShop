/**
 * vitest 全局设置（jsdom 环境，见 `vite.config.ts` 的 `test.environment`）。
 *
 * 只做两件事：
 * 1. 每个用例后清理已挂载的 React 树（`@testing-library/react` 要求显式清理）；
 * 2. 提供 jsdom 缺失的 `crypto.randomUUID`（`src/lib/idempotency.ts` 会用它）。
 *
 * **不引入 `@testing-library/jest-dom`**：本项目的断言用 `textContent` / `queryByText`
 * 即可表达，少一个依赖就少一处与并行同事的 lockfile 冲突面。
 */

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});

if (typeof crypto !== "undefined" && typeof crypto.randomUUID !== "function") {
  Object.defineProperty(crypto, "randomUUID", {
    value: (): string => `test-${String(Math.random()).slice(2, 12)}`,
    configurable: true,
  });
}
