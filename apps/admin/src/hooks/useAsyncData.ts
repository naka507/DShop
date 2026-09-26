/**
 * 列表数据加载 hook（后台页面通用）。
 *
 * 只做三件事：加载中 / 错误 / 数据，并把 `ApiError` 的文案直接暴露给页面。
 * 不引入 TanStack Query —— 后台是桌面优先的 CRUD 界面，页面级 `useState` 足够，
 * 避免在 M0 增加依赖面。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError } from "../api/client.js";
import { describeErrorCode } from "../api/errors.js";

/** 异步数据状态。 */
export interface AsyncState<T> {
  readonly data: T | null;
  readonly loading: boolean;
  /** 错误文案（已按错误码分流归一）；无错误为 `null`。 */
  readonly error: string | null;
  /** 原始错误对象（需要判断 `isForbidden` 等时使用）。 */
  readonly rawError: ApiError | null;
  /** 重新加载。 */
  readonly reload: () => void;
}

/**
 * 加载一次（或依赖变化时重载）异步数据。
 *
 * `deps` 变化会重新请求；卸载或依赖变化时用 `AbortController` 取消在途请求。
 */
export function useAsyncData<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[] = [],
): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rawError, setRawError] = useState<ApiError | null>(null);
  const [nonce, setNonce] = useState(0);

  // loader 每次渲染都是新函数引用，用 ref 固定最新值，避免把它放进 deps。
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    const controller = new AbortController();
    let alive = true;

    setLoading(true);
    setError(null);
    setRawError(null);

    loaderRef
      .current(controller.signal)
      .then((value) => {
        if (!alive) return;
        setData(value);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (!alive) return;
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        const apiError = cause instanceof ApiError ? cause : null;
        setRawError(apiError);
        setError(
          apiError === null
            ? "请求失败，请稍后重试"
            : describeErrorCode(apiError.code, apiError.message),
        );
        setLoading(false);
      });

    return () => {
      alive = false;
      controller.abort();
    };
    // 依赖由调用方以 `deps` 显式给出（loader 通过 ref 取最新值，故意不进依赖数组）。
  }, [...deps, nonce]);

  const reload = useCallback(() => {
    setNonce((n) => n + 1);
  }, []);

  return { data, loading, error, rawError, reload };
}
