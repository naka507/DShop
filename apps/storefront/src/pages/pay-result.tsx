/**
 * 支付结果页（`docs/03` §3.5.1「交易 / 支付结果 `/pay/:orderNo/result`」）。
 *
 * 文档要求：**CSR + 轮询（Cache API 防抖）**——即升级缝 **S4**。
 *
 * ## S4 的默认实现就在这里生效
 *
 * 本页**不直接调接口**，而是通过 `useOrderStatus()` → `OrderStatusSource` 抽象，
 * 由 `PollingOrderStatusSource`（前端轮询 + 退避 + 页面不可见时暂停）提供数据。
 * 升级到 Durable Objects WebSocket / SSE 时，只换
 * `src/order-status/index.ts` 的工厂实现，**本文件零改动**
 * （`docs/04-Cloudflare资源与升级缝.md` §4.3）。
 *
 * 主单与子单状态由 `OrderStatusPanel` 统一渲染（`docs/08` §8.3 硬要求）。
 */

import type { ReactNode } from "react";
import { Link, useParams } from "react-router";

import { PageTitle } from "../components/app-shell.tsx";
import { OrderStatusPanel } from "../components/order-status-panel.tsx";
import { ErrorNotice, Loading } from "../components/ui.tsx";
import { useNow } from "../hooks/use-now.ts";
import { useOrderStatus } from "../hooks/use-order-status.ts";
import { formatRelativeTime } from "../lib/format.ts";

/** 支付结果页。 */
export function PayResultPage(): ReactNode {
  const params = useParams();
  const orderNo = params.orderNo ?? "";
  const { snapshot, error, paused, refresh } = useOrderStatus(orderNo === "" ? undefined : orderNo);
  // 每 5 秒重算一次「x 秒前更新」，避免相对时间在页面上冻结。
  const now = useNow(5000);

  return (
    <section>
      <PageTitle>支付结果</PageTitle>
      <p className="mb-3 text-sm text-gray-500">订单号：{orderNo}</p>

      {snapshot === null && error === null && <Loading label="正在查询订单状态…" />}
      {error !== null && <ErrorNotice error={error} onRetry={refresh} />}

      {snapshot !== null && (
        <>
          <OrderStatusPanel
            orderNo={snapshot.orderNo}
            status={snapshot.status}
            statusText={snapshot.statusText}
            subOrders={snapshot.subOrders}
            footer={
              <>
                {paused
                  ? "页面不可见，已暂停自动刷新"
                  : `更新于 ${formatRelativeTime(snapshot.fetchedAt, now)}`}
                <button
                  type="button"
                  onClick={refresh}
                  className="ml-3 rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-700"
                >
                  刷新状态
                </button>
              </>
            }
          />

          <div className="mt-4 flex gap-4 text-sm">
            <Link
              to={`/orders/${encodeURIComponent(orderNo)}`}
              className="text-blue-600 hover:underline"
            >
              查看订单详情
            </Link>
            <Link to="/orders" className="text-blue-600 hover:underline">
              我的订单
            </Link>
          </div>
        </>
      )}
    </section>
  );
}
