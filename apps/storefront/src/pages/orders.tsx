/**
 * 订单列表（`docs/03` §3.5.1「会员 / 订单列表 `/orders`」）：
 * 分页 `{page,pageSize,total,list}`（`docs/06` §6 三组统一分页）。
 */

import type { ReactNode } from "react";
import { useCallback } from "react";
import { Link, useSearchParams } from "react-router";

import { listOrders } from "../api/client.ts";
import { PageTitle } from "../components/app-shell.tsx";
import { Empty, ErrorNotice, Loading, StatusBadge } from "../components/ui.tsx";
import { useAsync } from "../hooks/use-async.ts";
import { formatDateTime, formatPrice } from "../lib/format.ts";

/** 主单状态筛选项（取值来自 `packages/shared` 的 `ORDER_STATUS`）。 */
const STATUS_FILTERS: readonly { readonly value: string; readonly label: string }[] = [
  { value: "", label: "全部" },
  { value: "PENDING_PAYMENT", label: "待支付" },
  { value: "PAID", label: "已支付" },
  { value: "SHIPPED", label: "已发货" },
  { value: "COMPLETED", label: "已完成" },
  { value: "CANCELLED", label: "已取消" },
];

/** 订单列表页。 */
export function OrdersPage(): ReactNode {
  const [searchParams, setSearchParams] = useSearchParams();
  const status = searchParams.get("status") ?? "";
  const page = Number(searchParams.get("page") ?? "1") || 1;

  const load = useCallback(
    () => listOrders({ status: status === "" ? undefined : status, page, pageSize: 10 }),
    [status, page],
  );
  const { data, error, loading, reload } = useAsync(load);

  return (
    <section>
      <PageTitle>我的订单</PageTitle>
      <nav className="mb-4 flex flex-wrap gap-2">
        {STATUS_FILTERS.map((filter) => (
          <button
            key={filter.value}
            type="button"
            onClick={() => {
              const next = new URLSearchParams();
              if (filter.value !== "") next.set("status", filter.value);
              setSearchParams(next);
            }}
            className={`rounded border px-3 py-1 text-sm ${
              status === filter.value
                ? "border-gray-900 bg-gray-900 text-white"
                : "border-gray-200 text-gray-700"
            }`}
          >
            {filter.label}
          </button>
        ))}
      </nav>

      {loading && <Loading />}
      {error !== null && <ErrorNotice error={error} onRetry={reload} />}
      {data !== null && data.list.length === 0 && <Empty label="暂无订单" />}
      {data !== null && data.list.length > 0 && (
        <>
          <ul className="space-y-3">
            {data.list.map((order) => (
              <li key={order.orderNo} className="rounded border border-gray-200 bg-white p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link
                    to={`/orders/${encodeURIComponent(order.orderNo)}`}
                    className="text-sm font-medium text-gray-900 hover:underline"
                  >
                    {order.orderNo}
                  </Link>
                  <StatusBadge text={order.statusText} />
                </div>
                <p className="mt-1 text-sm text-gray-700">{order.itemSummary}</p>
                <p className="mt-1 text-xs text-gray-500">
                  共 {order.itemCount} 件 · {order.subOrderCount} 个子单
                  {order.allShipped ? " · 已全部发货" : ""}
                  {order.hasOpenAftersale ? " · 有进行中的售后" : ""}
                </p>
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-xs text-gray-400">{formatDateTime(order.createdAt)}</span>
                  <span className="text-sm font-semibold text-red-600">
                    {formatPrice(order.payAmount)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
          {data.total > data.pageSize && (
            <div className="mt-4 flex justify-between text-sm">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => {
                  const next = new URLSearchParams(searchParams);
                  next.set("page", String(page - 1));
                  setSearchParams(next);
                }}
                className="rounded border px-3 py-1 disabled:opacity-40"
              >
                上一页
              </button>
              <button
                type="button"
                disabled={page * data.pageSize >= data.total}
                onClick={() => {
                  const next = new URLSearchParams(searchParams);
                  next.set("page", String(page + 1));
                  setSearchParams(next);
                }}
                className="rounded border px-3 py-1 disabled:opacity-40"
              >
                下一页
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
