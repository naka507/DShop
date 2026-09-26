/**
 * 极简数据获取 hook（交易/会员类页面为 CSR + 强交互，`docs/03` §3.5.1）。
 *
 * ## 为什么不用 TanStack Query
 *
 * 任务说明 TanStack Query 是**可选**的。本版不引入，原因是：
 * - 页面需要的只是「取一次 + 手动重取 + 加载/错误态」；
 * - 少一个依赖就少一处与并行同事的 lockfile 冲突面（本任务禁止 `npm install`）；
 * - 订单实时性由 S4 抽象（`src/order-status/*`）承担，与通用缓存层无关。
 *
 * **后续升级**：若引入 TanStack Query，只需把 `useAsync` 的调用点换成
 * `useQuery`，`src/api/client.ts` 的函数可直接作为 `queryFn`（同签名同返回）。
 */

import { useCallback, useEffect, useRef, useState } from "react";

/** `useAsync` 的返回。 */
export interface AsyncState<T> {
  readonly data: T | null;
  readonly error: unknown;
  readonly loading: boolean;
  /** 手动重取（用户点「重试」）。 */
  readonly reload: () => void;
}

/**
 * 执行一次异步取数。
 *
 * @param loader 取数函数；**必须是稳定引用**（用 `useCallback` 包），
 *               否则每次渲染都会重新请求。
 * @param enabled 为 `false` 时不请求（例如未登录、参数缺失）。
 */
export function useAsync<T>(loader: () => Promise<T>, enabled = true): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(enabled);
  const [nonce, setNonce] = useState(0);

  // 组件卸载后不再 setState（避免 React 警告与竞态覆盖）。
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    loader()
      .then((result) => {
        if (cancelled || !mountedRef.current) return;
        setData(result);
      })
      .catch((cause: unknown) => {
        if (cancelled || !mountedRef.current) return;
        setError(cause);
      })
      .finally(() => {
        if (cancelled || !mountedRef.current) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loader, enabled, nonce]);

  const reload = useCallback(() => {
    setNonce((value) => value + 1);
  }, []);

  return { data, error, loading, reload };
}
