/**
 * S4 默认实现（前端轮询）的行为测试。
 *
 * 权威来源：`docs/04-Cloudflare资源与升级缝.md` §4.3
 * ——S4 默认 = 前端轮询，升级 = Durable Objects WebSocket / SSE。
 *
 * 覆盖任务要求的三条行为：
 * 1. 页面**可见**时按间隔轮询；
 * 2. 页面**不可见**时暂停（停表 + 发 `paused` 事件），恢复可见时立即取数（`resumed`）；
 * 3. 失败时**退避**（间隔指数放大、封顶），成功一次后回到基准间隔。
 *
 * ## 为什么不用 `vi.useFakeTimers()`
 *
 * 实现把定时器经 `PollingEnv` 注入，因此测试可以用一个**手控时钟**精确断言
 * 「下一次请求被安排在多少毫秒后」——比 fake timers 更直白，也不受
 * microtask / 宏任务交织顺序影响。这是把环境依赖做成参数的直接收益。
 */

import { describe, expect, it, vi } from "vitest";

import { PollingOrderStatusSource, computeBackoffDelay } from "../src/order-status/polling.ts";
import type { PollingEnv } from "../src/order-status/polling.ts";
import type { OrderStatusEvent, OrderStatusSnapshot } from "../src/order-status/source.ts";

/** 构造一个合法快照（主单 + 子单状态都在）。 */
function makeSnapshot(orderNo: string): OrderStatusSnapshot {
  return {
    orderNo,
    status: "PAID",
    statusText: "已支付",
    subOrders: [{ subOrderNo: `${orderNo}-01`, status: "PAID", statusText: "待发货" }],
    fetchedAt: 1_700_000_000_000,
  };
}

/** 手控时钟：记录所有被安排的定时器，支持手动推进。 */
class ManualClock {
  /** 已安排的定时器：句柄 → { 回调, 延迟 }。 */
  readonly scheduled = new Map<
    number,
    { readonly handler: () => void; readonly delayMs: number }
  >();
  /** 被清除的句柄（断言「不可见时真的停表」用）。 */
  readonly cleared: number[] = [];
  #nextHandle = 1;

  setTimeout(handler: () => void, delayMs: number): number {
    const handle = this.#nextHandle;
    this.#nextHandle += 1;
    this.scheduled.set(handle, { handler, delayMs });
    return handle;
  }

  clearTimeout(handle: number): void {
    this.cleared.push(handle);
    this.scheduled.delete(handle);
  }

  /** 当前待执行的定时器延迟列表（按安排顺序）。 */
  pendingDelays(): number[] {
    return [...this.scheduled.values()].map((entry) => entry.delayMs);
  }

  /** 推进一次：执行最早安排的定时器回调。 */
  async runNext(): Promise<void> {
    const first = [...this.scheduled.entries()][0];
    if (first === undefined) return;
    const [handle, entry] = first;
    this.scheduled.delete(handle);
    entry.handler();
    // 让 await fetchSnapshot 的微任务跑完（tick 是 async）。
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }
}

/** 构造注入环境。 */
function makeEnv(options: {
  readonly clock: ManualClock;
  readonly fetchSnapshot: (orderNo: string) => Promise<OrderStatusSnapshot>;
  readonly visible?: boolean;
}): {
  readonly env: PollingEnv;
  readonly setVisible: (visible: boolean) => void;
} {
  let visible = options.visible ?? true;
  let listener: ((visible: boolean) => void) | null = null;

  return {
    env: {
      fetchSnapshot: options.fetchSnapshot,
      isVisible: () => visible,
      onVisibilityChange: (next) => {
        listener = next;
        return () => {
          listener = null;
        };
      },
      setTimeout: (handler, delayMs) => options.clock.setTimeout(handler, delayMs),
      clearTimeout: (handle) => {
        options.clock.clearTimeout(handle);
      },
    },
    setVisible: (next) => {
      visible = next;
      listener?.(next);
    },
  };
}

describe("computeBackoffDelay（退避算法）", () => {
  it("成功（failureCount=0）时返回基准间隔", () => {
    expect(computeBackoffDelay(0, { baseIntervalMs: 1000 })).toBe(1000);
  });

  it("连续失败时指数放大", () => {
    const options = { baseIntervalMs: 1000, backoffFactor: 2, maxIntervalMs: 60_000 };
    expect(computeBackoffDelay(1, options)).toBe(2000);
    expect(computeBackoffDelay(2, options)).toBe(4000);
    expect(computeBackoffDelay(3, options)).toBe(8000);
  });

  it("放大到上限后不再增长（封顶）", () => {
    const options = { baseIntervalMs: 1000, backoffFactor: 2, maxIntervalMs: 5000 };
    expect(computeBackoffDelay(10, options)).toBe(5000);
  });
});

describe("PollingOrderStatusSource（S4 默认实现）", () => {
  it("页面可见时立即取数，并按基准间隔安排下一次", async () => {
    const clock = new ManualClock();
    const fetchSnapshot = vi.fn(() => Promise.resolve(makeSnapshot("DS20260920143000123")));
    const { env } = makeEnv({ clock, fetchSnapshot, visible: true });

    const source = new PollingOrderStatusSource(env, { baseIntervalMs: 2000 });
    const events: OrderStatusEvent[] = [];
    const subscription = source.subscribe("DS20260920143000123", (event) => events.push(event));

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    expect(events[0]?.type).toBe("snapshot");
    // 成功一次后按基准间隔排下一次。
    expect(clock.pendingDelays()).toEqual([2000]);

    subscription.unsubscribe();
  });

  it("页面不可见时暂停：不排下一次取数，并发出 paused 事件", async () => {
    const clock = new ManualClock();
    const fetchSnapshot = vi.fn(() => Promise.resolve(makeSnapshot("DS20260920143000123")));
    const { env, setVisible } = makeEnv({ clock, fetchSnapshot, visible: true });

    const source = new PollingOrderStatusSource(env, { baseIntervalMs: 2000 });
    const events: OrderStatusEvent[] = [];
    const subscription = source.subscribe("DS20260920143000123", (event) => events.push(event));

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);

    // 切到后台：停表 + paused 事件。
    setVisible(false);
    expect(events.some((event) => event.type === "paused")).toBe(true);
    expect(clock.pendingDelays()).toEqual([]);

    // 即便推进时钟也不会再请求（因为已经没有待执行的定时器）。
    await clock.runNext();
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);

    subscription.unsubscribe();
  });

  it("恢复可见时立即取数并发 resumed 事件", async () => {
    const clock = new ManualClock();
    const fetchSnapshot = vi.fn(() => Promise.resolve(makeSnapshot("DS20260920143000123")));
    const { env, setVisible } = makeEnv({ clock, fetchSnapshot, visible: true });

    const source = new PollingOrderStatusSource(env, { baseIntervalMs: 2000 });
    const events: OrderStatusEvent[] = [];
    const subscription = source.subscribe("DS20260920143000123", (event) => events.push(event));

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);

    setVisible(false);
    setVisible(true);

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(events.some((event) => event.type === "resumed")).toBe(true);
    // 恢复后立即取数（不等一个 interval）。
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);

    subscription.unsubscribe();
  });

  it("订阅时页面已不可见 → 只发 paused，不取数", () => {
    const clock = new ManualClock();
    const fetchSnapshot = vi.fn(() => Promise.resolve(makeSnapshot("DS20260920143000123")));
    const { env } = makeEnv({ clock, fetchSnapshot, visible: false });

    const source = new PollingOrderStatusSource(env, { baseIntervalMs: 2000 });
    const events: OrderStatusEvent[] = [];
    const subscription = source.subscribe("DS20260920143000123", (event) => events.push(event));

    expect(fetchSnapshot).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual(["paused"]);
    expect(clock.pendingDelays()).toEqual([]);

    subscription.unsubscribe();
  });

  it("取数失败时退避：下一次间隔按倍数放大，并在成功后回到基准间隔", async () => {
    const clock = new ManualClock();
    let shouldFail = true;
    const fetchSnapshot = vi.fn(() =>
      shouldFail
        ? Promise.reject(new Error("网络失败"))
        : Promise.resolve(makeSnapshot("DS20260920143000123")),
    );
    const { env } = makeEnv({ clock, fetchSnapshot, visible: true });

    const source = new PollingOrderStatusSource(env, {
      baseIntervalMs: 1000,
      backoffFactor: 2,
      maxIntervalMs: 10_000,
    });
    const events: OrderStatusEvent[] = [];
    const subscription = source.subscribe("DS20260920143000123", (event) => events.push(event));

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // 第 1 次失败 → 退避 2000ms，且发出 error 事件（订阅不终止）。
    expect(events[0]?.type).toBe("error");
    expect(clock.pendingDelays()).toEqual([2000]);

    await clock.runNext();
    // 第 2 次失败 → 4000ms。
    expect(clock.pendingDelays()).toEqual([4000]);

    // 恢复成功 → 回到基准间隔 1000ms。
    shouldFail = false;
    await clock.runNext();
    expect(clock.pendingDelays()).toEqual([1000]);
    expect(events.some((event) => event.type === "snapshot")).toBe(true);

    subscription.unsubscribe();
  });

  it("unsubscribe 后不再回调，也不留定时器", async () => {
    const clock = new ManualClock();
    const fetchSnapshot = vi.fn(() => Promise.resolve(makeSnapshot("DS20260920143000123")));
    const { env } = makeEnv({ clock, fetchSnapshot, visible: true });

    const source = new PollingOrderStatusSource(env, { baseIntervalMs: 2000 });
    const events: OrderStatusEvent[] = [];
    const subscription = source.subscribe("DS20260920143000123", (event) => events.push(event));

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const countAfterFirstFetch = events.length;

    subscription.unsubscribe();
    expect(clock.pendingDelays()).toEqual([]);

    await clock.runNext();
    expect(events.length).toBe(countAfterFirstFetch);
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
  });

  it("refresh() 立即取数（不改变退避状态）", async () => {
    const clock = new ManualClock();
    const fetchSnapshot = vi.fn(() => Promise.resolve(makeSnapshot("DS20260920143000123")));
    const { env } = makeEnv({ clock, fetchSnapshot, visible: true });

    const source = new PollingOrderStatusSource(env, { baseIntervalMs: 2000 });
    const subscription = source.subscribe("DS20260920143000123", () => undefined);

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);

    subscription.refresh();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);

    subscription.unsubscribe();
  });
});
