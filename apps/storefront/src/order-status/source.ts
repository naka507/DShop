/**
 * 订单状态订阅抽象 —— **升级缝 S4 的接口定义**。
 *
 * ## 权威来源
 *
 * `docs/04-Cloudflare资源与升级缝.md` §4.3 升级缝表：
 *
 * | 缝 | 能力 | 默认实现 | 升级为 | 切换方式 |
 * | --- | --- | --- | --- | --- |
 * | **S4** | 实时推送 | **前端轮询（Cache API 防抖）** | Durable Objects WebSocket / SSE | **前端 `OrderStatusSource` 抽象换实现** |
 *
 * ## 设计要点
 *
 * 1. **业务代码只依赖本接口**（`OrderStatusSource` / `OrderStatusSnapshot`），
 *    不感知「轮询」还是「WebSocket」。页面组件调用 `source.subscribe(orderNo, listener)`，
 *    拿到快照就渲染，拿到错误就提示。
 * 2. **默认实现 = `PollingOrderStatusSource`**（见 `src/order-status/polling.ts`），
 *    带退避与页面不可见时暂停。
 * 3. **升级 = 换实现**：新增 `WebSocketOrderStatusSource implements OrderStatusSource`
 *    （接 Durable Object），把 `src/order-status/index.ts` 里的工厂指向它即可，
 *    **页面与组件零改动**。
 * 4. ⚠️ **默认不引入 WebSocket / SSE**：`docs/04` §4.3 的纪律是「付费/高级组件一律藏在
 *    自研接口后面、由**绑定存在性**驱动；DShop 默认配置不绑定任何 Durable Object」。
 *    因此本目录**不得**出现 `new WebSocket(...)` / `EventSource`。
 */

import type { OrderStatus, SubOrderStatus } from "@dshop/shared";

/** 单个子单的状态快照（子单状态独立流转，`docs/08` §8.3）。 */
export interface SubOrderStatusSnapshot {
  readonly subOrderNo: string;
  readonly status: SubOrderStatus;
  readonly statusText: string;
}

/**
 * 一次订单状态的完整快照。
 *
 * **主单与子单状态必须同时存在**：`docs/08` §8.3 要求客服与用户都能答
 * 「买了三件为什么只发一件」，因此快照结构上不允许只给主单状态。
 */
export interface OrderStatusSnapshot {
  readonly orderNo: string;
  readonly status: OrderStatus;
  readonly statusText: string;
  readonly subOrders: readonly SubOrderStatusSnapshot[];
  /** 本次取数的本地时间戳（ms）。用于展示「x 秒前更新」。 */
  readonly fetchedAt: number;
}

/** 订阅事件。 */
export type OrderStatusEvent =
  /** 成功取到快照（首次取数也会发一次）。 */
  | { readonly type: "snapshot"; readonly snapshot: OrderStatusSnapshot }
  /** 取数失败（轮询实现会自动重试；错误仅作提示，不终止订阅）。 */
  | { readonly type: "error"; readonly error: unknown }
  /**
   * 因**页面不可见**而暂停轮询。
   *
   * 轮询实现必须发这个事件而不是静默停止：UI 需要据此展示「已暂停刷新」，
   * 否则用户回到页面时会看到过期状态却以为是最新的。
   */
  | { readonly type: "paused"; readonly reason: "hidden" }
  /** 页面恢复可见，轮询已重启。 */
  | { readonly type: "resumed" };

/** 订阅回调。 */
export type OrderStatusListener = (event: OrderStatusEvent) => void;

/** 订阅句柄。 */
export interface OrderStatusSubscription {
  /** 取消订阅（幂等；必须清除所有定时器与事件监听，避免泄漏）。 */
  unsubscribe(): void;
  /** 立即取一次数（用户点击「刷新」或状态变更后调用）。 */
  refresh(): void;
}

/**
 * ★ S4 升级缝的抽象本身。
 *
 * 实现者只需保证：`subscribe` 返回后，**至少**会为每个状态变化回调一次
 * `{ type: "snapshot" }`，并在 `unsubscribe()` 后停止一切回调。
 */
export interface OrderStatusSource {
  /**
   * 订阅某个订单的状态。
   *
   * @param orderNo 主单号（`^DS\d{17}$`，`docs/05` §5.3⑤）。
   * @param listener 事件回调；**必须**在 `unsubscribe()` 后不再被调用。
   */
  subscribe(orderNo: string, listener: OrderStatusListener): OrderStatusSubscription;
}
