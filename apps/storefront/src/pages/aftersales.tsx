/**
 * 售后列表（`docs/03` §3.5.1「会员 / 售后列表」）。
 *
 * 文档页面清单里只列了「售后申请」与「售后详情」，但任务要求包含「售后列表」，
 * 因此本页按 `GET /api/v1/shop/aftersales`（分页 `{page,pageSize,total,list}`）实现。
 */

import type { ReactNode } from "react";
import { useCallback } from "react";
import { Link, useSearchParams } from "react-router";

import { listAftersales } from "../api/client.ts";
import { PageTitle } from "../components/app-shell.tsx";
import { Empty, ErrorNotice, Loading, StatusBadge } from "../components/ui.tsx";
import { useAsync } from "../hooks/use-async.ts";
import { formatDateTime, formatPrice } from "../lib/format.ts";

/** 售后列表页。 */
export function AftersalesPage(): ReactNode {
  const [searchParams, setSearchParams] = useSearchParams();
  const page = Number(searchParams.get("page") ?? "1") || 1;

  const load = useCallback(() => listAftersales({ page, pageSize: 10 }), [page]);
  const { data, error, loading, reload } = useAsync(load);

  return (
    <section>
      <PageTitle>我的售后</PageTitle>
      {loading && <Loading />}
      {error !== null && <ErrorNotice error={error} onRetry={reload} />}
      {data !== null && data.list.length === 0 && <Empty label="暂无售后记录" />}
      {data !== null && data.list.length > 0 && (
        <>
          <ul className="space-y-3">
            {data.list.map((item) => (
              <li key={item.aftersaleNo} className="rounded border border-gray-200 bg-white p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link
                    to={`/aftersales/${encodeURIComponent(item.aftersaleNo)}`}
                    className="text-sm font-medium text-gray-900 hover:underline"
                  >
                    {item.aftersaleNo}
                  </Link>
                  <StatusBadge
                    text={item.statusText}
                    tone={item.status === "REFUNDED" ? "success" : "info"}
                  />
                </div>
                <p className="mt-1 text-sm text-gray-700">
                  {item.typeText} · {item.itemTitle}
                </p>
                <p className="mt-1 text-xs text-gray-500">关联订单：{item.orderNo}</p>
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-xs text-gray-400">{formatDateTime(item.createdAt)}</span>
                  <span className="text-sm font-semibold text-red-600">
                    {formatPrice(item.refundAmount)}
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
                  setSearchParams({ page: String(page - 1) });
                }}
                className="rounded border px-3 py-1 disabled:opacity-40"
              >
                上一页
              </button>
              <button
                type="button"
                disabled={page * data.pageSize >= data.total}
                onClick={() => {
                  setSearchParams({ page: String(page + 1) });
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
