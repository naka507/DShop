/**
 * React 侧的订单状态订阅 hook。
 *
 * **本 hook 只依赖 `OrderStatusSource` 抽象**，因此 S4 从「前端轮询」升级到
 * 「Durable Objects WebSocket / SSE」时，本文件与所有页面**零改动**
 * （`docs/04-Cloudflare资源与升级缝.md` §4.3）。
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { createOrderStatusSource } from "../order-status/index.ts";
import type { OrderStatusSnapshot, OrderStatusSource } from "../order-status/index.ts";

/** hook 返回值。 */
export interface UseOrderStatusResult {
  /** 最近一次成功快照；尚未取到时为 `null`。 */
  readonly snapshot: OrderStatusSnapshot | null;
  /** 最近一次错误（成功取数后清空）。 */
  readonly error: unknown;
  /** 是否因页面不可见而暂停刷新。 */
  readonly paused: boolean;
  /** 手动刷新（用户点「刷新状态」）。 */
  readonly refresh: () => void;
}

/**
 * 订阅订单状态。
 *
 * @param orderNo 主单号；为 `undefined` 时不订阅（例如路由参数尚未就绪）。
 * @param source 可注入的状态源（测试用）；默认由工厂创建（S4 默认 = 轮询）。
 */
export function useOrderStatus(
  orderNo: string | undefined,
  source?: OrderStatusSource,
): UseOrderStatusResult {
  const [snapshot, setSnapshot] = useState<OrderStatusSnapshot | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [paused, setPaused] = useState(false);

  // 源只在挂载时创建一次，避免每次渲染重建导致重复订阅。
  const fallbackSource = useMemo(() => createOrderStatusSource(), []);
  const activeSource = source ?? fallbackSource;

  const subscriptionRef = useRef<{ refresh(): void } | null>(null);

  useEffect(() => {
    if (orderNo === undefined) {
      setSnapshot(null);
      return;
    }
    setSnapshot(null);
    setError(null);
    setPaused(false);

    const subscription = activeSource.subscribe(orderNo, (event) => {
      switch (event.type) {
        case "snapshot":
          setSnapshot(event.snapshot);
          setError(null);
          setPaused(false);
          break;
        case "error":
          setError(event.error);
          break;
        case "paused":
          setPaused(true);
          break;
        case "resumed":
          setPaused(false);
          break;
      }
    });
    subscriptionRef.current = subscription;

    return () => {
      subscription.unsubscribe();
      subscriptionRef.current = null;
    };
  }, [activeSource, orderNo]);

  const refresh = useMemo(
    () => () => {
      subscriptionRef.current?.refresh();
    },
    [],
  );

  return { snapshot, error, paused, refresh };
}
