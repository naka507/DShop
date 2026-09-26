/**
 * 订单状态源的工厂 —— **S4 升级缝的唯一切换点**。
 *
 * ## 升级到 Durable Objects WebSocket / SSE 时改这里
 *
 * ```ts
 * // 默认（本文件当前形态）：
 * return new PollingOrderStatusSource(createBrowserPollingEnv());
 *
 * // 升级后：
 * return new WebSocketOrderStatusSource(createDurableObjectEnv());
 * ```
 *
 * **页面与 hook 零改动**——它们只依赖 `OrderStatusSource` 接口。
 * 详见 `src/order-status/source.ts` 与 `docs/04-Cloudflare资源与升级缝.md` §4.3。
 */

import { getOrder } from "../api/client.ts";
import type { OrderDetailView } from "../api/types.ts";
import { PollingOrderStatusSource } from "./polling.ts";
import type { PollingEnv, PollingOptions } from "./polling.ts";
import type { OrderStatusSnapshot, OrderStatusSource } from "./source.ts";

/**
 * 把订单详情投影成状态快照。
 *
 * **同时保留主单与子单状态**（`docs/08-核心业务流程.md` §8.3）——
 * 页面需要两级都展示，因此快照不允许只携带主单状态。
 */
export function toOrderStatusSnapshot(
  detail: OrderDetailView,
  fetchedAt: number,
): OrderStatusSnapshot {
  return {
    orderNo: detail.orderNo,
    status: detail.status,
    statusText: detail.statusText,
    subOrders: detail.subOrders.map((sub) => ({
      subOrderNo: sub.subOrderNo,
      status: sub.status,
      statusText: sub.statusText,
    })),
    fetchedAt,
  };
}

/**
 * 浏览器环境下的轮询依赖。
 *
 * - 取数走 `getOrder()`（相对路径 `/api/v1/shop/orders/:orderNo`，见 `transport.ts` 铁律）；
 * - 可见性用 `document.visibilityState`（jsdom 下同样可用，`hidden` 属性可被测试改写）。
 */
export function createBrowserPollingEnv(): PollingEnv {
  return {
    async fetchSnapshot(orderNo) {
      const detail = await getOrder(orderNo);
      return toOrderStatusSnapshot(detail, Date.now());
    },
    isVisible: () =>
      typeof document === "undefined" ? true : document.visibilityState !== "hidden",
    onVisibilityChange: (listener) => {
      if (typeof document === "undefined") return () => undefined;
      const handler = (): void => {
        listener(document.visibilityState !== "hidden");
      };
      document.addEventListener("visibilitychange", handler);
      return () => {
        document.removeEventListener("visibilitychange", handler);
      };
    },
    setTimeout: (handler, timeoutMs) =>
      globalThis.setTimeout(handler, timeoutMs) as unknown as number,
    clearTimeout: (handle) => {
      globalThis.clearTimeout(handle);
    },
  };
}

/**
 * 创建订单状态源。
 *
 * ★ **当前返回 `PollingOrderStatusSource`（S4 默认实现）**。
 * 本函数是升级缝的唯一入口，页面不直接 new 任何具体实现。
 */
export function createOrderStatusSource(
  env: PollingEnv = createBrowserPollingEnv(),
  options: PollingOptions = {},
): OrderStatusSource {
  // S4 默认 = 前端轮询；升级 = 换成 Durable Objects WebSocket / SSE 的实现。
  return new PollingOrderStatusSource(env, options);
}

export { PollingOrderStatusSource, computeBackoffDelay } from "./polling.ts";
export type { PollingEnv, PollingOptions } from "./polling.ts";
export type {
  OrderStatusEvent,
  OrderStatusListener,
  OrderStatusSnapshot,
  OrderStatusSource,
  OrderStatusSubscription,
  SubOrderStatusSnapshot,
} from "./source.ts";
