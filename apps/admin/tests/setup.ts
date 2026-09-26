/**
 * 单测全局准备（`vitest` 的 `setupFiles`）。
 *
 * - jsdom 缺 `matchMedia` / `ResizeObserver`，antd 5 的响应式与虚拟列表需要它们
 * - 默认把 `fetch` 设为**抛错**：任何未显式 stub 的网络调用都会让用例失败，
 *   避免单测意外打到真实接口（`docs/04` §4.1 的 Service Binding 转发不可在单测中触发）
 */

import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

/* antd 依赖的浏览器 API 补丁（jsdom 未实现） */
if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  });
}

if (!("ResizeObserver" in globalThis)) {
  class ResizeObserverStub {
    public observe(): void {
      // 测试无需真实尺寸观察
    }
    public unobserve(): void {
      // 测试无需真实尺寸观察
    }
    public disconnect(): void {
      // 测试无需真实尺寸观察
    }
  }
  Object.defineProperty(globalThis, "ResizeObserver", {
    writable: true,
    value: ResizeObserverStub,
  });
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("单测禁止真实网络调用：请在本用例内 stub fetch");
    }),
  );
});

afterEach(() => {
  // vitest 未开 globals，@testing-library/react 的自动清理不会注册，须显式调用。
  // 否则同一测试文件内多次 render 会累积 DOM，出现「Found multiple elements」。
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
