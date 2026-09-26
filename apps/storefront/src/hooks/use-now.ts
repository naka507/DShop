/**
 * 「当前时间」hook：以固定间隔触发重渲染。
 *
 * 用途：展示「更新于 x 秒前」这类**相对时间**。若只在数据变化时渲染，
 * 相对时间会在页面上冻结（轮询成功但文案不变，看起来像卡住）。
 *
 * 页面不可见时自动暂停计时，避免无意义的渲染（与 S4 轮询的暂停策略一致）。
 */

import { useEffect, useState } from "react";

/**
 * 返回一个每 `intervalMs` 毫秒更新一次的当前时间戳。
 *
 * @param intervalMs 刷新间隔（ms）。
 */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = globalThis.setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      setNow(Date.now());
    }, intervalMs);
    return () => {
      globalThis.clearInterval(id);
    };
  }, [intervalMs]);

  return now;
}
