/**
 * **S4 默认实现：前端轮询**（`docs/04-Cloudflare资源与升级缝.md` §4.3）。
 *
 * > S4 实时推送：**默认** = 前端轮询（Cache API 防抖）；**升级** = Durable Objects
 * > WebSocket / SSE，切换方式 = **前端 `OrderStatusSource` 抽象换实现**。
 *
 * ## 本文件就是那个「默认」
 *
 * - **升级时不要改本文件**：另写一个 `implements OrderStatusSource` 的
 *   `WebSocketOrderStatusSource`，改 `src/order-status/index.ts` 的工厂指向即可，
 *   **业务代码（页面、组件、hook）零改动**。
 * - 本文件**不含**任何 `WebSocket` / `EventSource` 引用（`docs/04` §4.3 纪律：
 *   默认配置不绑定任何 Durable Object）。
 *
 * ## 两条必须的行为（任务硬要求）
 *
 * 1. **退避（backoff）**：连续失败时轮询间隔按指数放大（封顶 `maxIntervalMs`），
 *    成功一次即回到 `baseIntervalMs`。这直接对应免费层额度约束
 *    （`docs/09` §10.1：Workers 10 万请求/天、10ms CPU/请求），避免后端抖动时
 *    被前端轮询打垮。
 * 2. **页面不可见时暂停**：`document.visibilityState === "hidden"` 时**完全停表**
 *    （不是拉长间隔），并发 `{type:"paused"}` 事件；恢复可见时立即取一次数并发
 *    `{type:"resumed"}`。移动端 H5 后台驻留是常态（`docs/03` §3.5.3），
 *    不暂停会持续消耗额度且耗电。
 *
 * ## 可测试性
 *
 * 所有环境依赖（取数、定时器、可见性、当前时间）都经 `PollingEnv` 注入，
 * 因此 `tests/order-status-polling.test.ts` 可以用假定时器断言
 * 「可见 → 轮询、不可见 → 停表、失败 → 退避」而无需真实浏览器。
 */

import type {
  OrderStatusEvent,
  OrderStatusListener,
  OrderStatusSnapshot,
  OrderStatusSource,
  OrderStatusSubscription,
} from "./source.ts";

/** 轮询实现的环境依赖（全部可注入）。 */
export interface PollingEnv {
  /** 取一次订单状态快照。实现内部应走 `/api/v1/shop/orders/:orderNo`。 */
  fetchSnapshot(orderNo: string): Promise<OrderStatusSnapshot>;
  /** 当前页面是否可见。 */
  isVisible(): boolean;
  /** 注册可见性变化监听，返回取消函数。 */
  onVisibilityChange(listener: (visible: boolean) => void): () => void;
  /** 定时器（测试注入假实现）。 */
  setTimeout(handler: () => void, timeoutMs: number): number;
  clearTimeout(handle: number): void;
}

/** 轮询参数。 */
export interface PollingOptions {
  /** 初始 / 正常轮询间隔（ms）。默认 2000。 */
  readonly baseIntervalMs?: number;
  /** 退避上限（ms）。默认 30000。 */
  readonly maxIntervalMs?: number;
  /** 退避倍数。默认 1.8。 */
  readonly backoffFactor?: number;
}

const DEFAULT_BASE_INTERVAL_MS = 2000;
const DEFAULT_MAX_INTERVAL_MS = 30_000;
const DEFAULT_BACKOFF_FACTOR = 1.8;

/**
 * 计算第 `failureCount` 次连续失败后的等待间隔（导出以便单测直接断言）。
 *
 * `failureCount = 0`（上一次成功）→ `baseIntervalMs`。
 */
export function computeBackoffDelay(failureCount: number, options: PollingOptions = {}): number {
  const base = options.baseIntervalMs ?? DEFAULT_BASE_INTERVAL_MS;
  const max = options.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS;
  const factor = options.backoffFactor ?? DEFAULT_BACKOFF_FACTOR;
  if (failureCount <= 0) return base;
  const raw = base * factor ** failureCount;
  return Math.min(Math.round(raw), max);
}

/**
 * ★ S4 默认实现：轮询式 `OrderStatusSource`。
 *
 * 升级到 Durable Objects WebSocket / SSE 时，本类被替换，但
 * `OrderStatusSource` 接口与所有调用方保持不变。
 */
export class PollingOrderStatusSource implements OrderStatusSource {
  readonly #env: PollingEnv;
  readonly #options: PollingOptions;

  constructor(env: PollingEnv, options: PollingOptions = {}) {
    this.#env = env;
    this.#options = options;
  }

  subscribe(orderNo: string, listener: OrderStatusListener): OrderStatusSubscription {
    let stopped = false;
    let timer: number | null = null;
    let inFlight = false;
    /** 连续失败次数，驱动退避。 */
    let failureCount = 0;

    const clearTimer = (): void => {
      if (timer !== null) {
        this.#env.clearTimeout(timer);
        timer = null;
      }
    };

    const emit = (event: OrderStatusEvent): void => {
      if (stopped) return;
      listener(event);
    };

    const schedule = (delayMs: number): void => {
      if (stopped) return;
      clearTimer();
      timer = this.#env.setTimeout(() => {
        timer = null;
        void tick();
      }, delayMs);
    };

    const tick = async (): Promise<void> => {
      if (stopped || inFlight) return;
      if (!this.#env.isVisible()) {
        // 不可见：不排下一次表，等 visibilitychange 唤醒（见 onVisibilityChange）。
        clearTimer();
        return;
      }
      inFlight = true;
      try {
        const snapshot = await this.#env.fetchSnapshot(orderNo);
        if (stopped) return;
        failureCount = 0;
        emit({ type: "snapshot", snapshot });
      } catch (error) {
        if (stopped) return;
        failureCount += 1;
        // 失败不终止订阅：页面仍需展示最后一次成功快照 + 错误提示。
        emit({ type: "error", error });
      } finally {
        inFlight = false;
        if (!stopped) schedule(computeBackoffDelay(failureCount, this.#options));
      }
    };

    const offVisibility = this.#env.onVisibilityChange((visible) => {
      if (stopped) return;
      if (visible) {
        // 恢复可见：立即取数（用户可能刚切回来，等一个 interval 会显得卡）。
        emit({ type: "resumed" });
        void tick();
      } else {
        clearTimer();
        emit({ type: "paused", reason: "hidden" });
      }
    });

    // 首次取数：可见则立即开始，不可见则先报 paused 等待唤醒。
    if (this.#env.isVisible()) {
      void tick();
    } else {
      emit({ type: "paused", reason: "hidden" });
    }

    return {
      unsubscribe: () => {
        if (stopped) return;
        stopped = true;
        clearTimer();
        offVisibility();
      },
      refresh: () => {
        if (stopped) return;
        // 手动刷新不改变退避状态，只是立刻取一次。
        void tick();
      },
    };
  }
}
