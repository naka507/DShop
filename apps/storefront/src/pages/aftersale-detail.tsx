/**
 * 售后详情（`docs/03` §3.5.1「会员 / 售后详情 `/aftersales/:aftersaleNo`」）：
 * 时间线取 `aftersale_logs`（`docs/07` §7.5 的 `timeline[]`）。
 *
 * 状态文案优先级：后端下发的 `statusText` → `@dshop/shared` 的
 * `AFTERSALE_STATUS_TEXT` 兜底，避免出现空白状态。
 */

import type { ReactNode } from "react";
import { useCallback } from "react";
import { useParams } from "react-router";

import { AFTERSALE_STATUS_TEXT } from "@dshop/shared";

import { getAftersale } from "../api/client.ts";
import { PageTitle } from "../components/app-shell.tsx";
import { ErrorNotice, Loading, StatusBadge } from "../components/ui.tsx";
import { useAsync } from "../hooks/use-async.ts";
import { formatDateTime, formatPrice } from "../lib/format.ts";

/** 售后详情页。 */
export function AftersaleDetailPage(): ReactNode {
  const params = useParams();
  const aftersaleNo = params.aftersaleNo ?? "";

  const load = useCallback(() => getAftersale(aftersaleNo), [aftersaleNo]);
  const { data, error, loading, reload } = useAsync(load, aftersaleNo !== "");

  const statusText =
    data === null
      ? ""
      : data.statusText !== ""
        ? data.statusText
        : AFTERSALE_STATUS_TEXT[data.status];

  return (
    <section className="mx-auto max-w-2xl">
      <PageTitle>售后详情</PageTitle>
      {loading && <Loading />}
      {error !== null && <ErrorNotice error={error} onRetry={reload} />}
      {data !== null && (
        <>
          <div className="rounded border border-gray-200 bg-white p-4">
            <div className="flex flex-wrap items-center gap-3">
              <StatusBadge
                text={statusText}
                tone={data.status === "REFUNDED" ? "success" : "info"}
              />
              <span className="text-xs text-gray-400">售后单号 {data.aftersaleNo}</span>
            </div>
            <dl className="mt-3 space-y-1 text-sm">
              <div className="flex gap-3">
                <dt className="w-24 shrink-0 text-gray-500">售后类型</dt>
                <dd className="text-gray-900">{data.typeText}</dd>
              </div>
              <div className="flex gap-3">
                <dt className="w-24 shrink-0 text-gray-500">商品</dt>
                <dd className="text-gray-900">
                  {data.itemTitle} × {data.quantity}
                </dd>
              </div>
              <div className="flex gap-3">
                <dt className="w-24 shrink-0 text-gray-500">退款金额</dt>
                <dd className="font-semibold text-red-600">
                  {formatPrice(data.refundAmount, data.currency)}
                </dd>
              </div>
              <div className="flex gap-3">
                <dt className="w-24 shrink-0 text-gray-500">关联订单</dt>
                <dd className="text-gray-900">
                  {data.orderNo}
                  <span className="ml-2 text-gray-500">{data.subOrderNo}</span>
                </dd>
              </div>
              <div className="flex gap-3">
                <dt className="w-24 shrink-0 text-gray-500">申请时间</dt>
                <dd className="text-gray-900">{formatDateTime(data.createdAt)}</dd>
              </div>
              <div className="flex gap-3">
                <dt className="w-24 shrink-0 text-gray-500">处理截止</dt>
                <dd className="text-gray-900">{formatDateTime(data.deadlineAt)}</dd>
              </div>
              <div className="flex gap-3">
                <dt className="w-24 shrink-0 text-gray-500">售后原因</dt>
                <dd className="text-gray-900">{data.reason ?? "—"}</dd>
              </div>
              <div className="flex gap-3">
                <dt className="w-24 shrink-0 text-gray-500">凭证数量</dt>
                <dd className="text-gray-900">{data.evidenceCount} 张</dd>
              </div>
            </dl>
          </div>

          {data.returnAddress !== null && (
            <section className="mt-4 rounded border border-gray-200 bg-white p-4">
              <h2 className="mb-2 text-sm font-medium text-gray-900">回寄地址</h2>
              <p className="text-sm text-gray-900">
                {data.returnAddress.name} {data.returnAddress.phone}
                <br />
                {data.returnAddress.province}
                {data.returnAddress.city}
                {data.returnAddress.district}
                {data.returnAddress.detail}
              </p>
              {data.returnExpress !== null && (
                <p className="mt-2 text-xs text-gray-500">
                  回寄物流：{data.returnExpress.company} {data.returnExpress.no}
                </p>
              )}
            </section>
          )}

          <section className="mt-4 rounded border border-gray-200 bg-white p-4">
            <h2 className="mb-2 text-sm font-medium text-gray-900">退款信息</h2>
            <p className="text-sm text-gray-700">
              状态：{data.refund.status}
              {data.refund.refundNo !== null ? ` · 退款单号 ${data.refund.refundNo}` : ""}
              {data.refund.channel !== null ? ` · 渠道 ${data.refund.channel}` : ""}
            </p>
            <p className="mt-1 text-xs text-gray-500">
              到账时间：{formatDateTime(data.refund.arrivedAt)}
              {data.refund.estimatedArrivalDays !== null
                ? `（预计 ${String(data.refund.estimatedArrivalDays)} 天）`
                : ""}
            </p>
          </section>

          <section className="mt-4">
            <h2 className="mb-2 text-sm font-medium text-gray-900">处理进度</h2>
            {data.timeline.length === 0 ? (
              <p className="text-sm text-gray-400">暂无进度记录</p>
            ) : (
              <ol className="space-y-3 border-l border-gray-200 pl-4">
                {data.timeline.map((entry) => (
                  <li key={`${entry.at}-${entry.to}`} className="relative">
                    <span className="absolute -left-[21px] top-1 h-2 w-2 rounded-full bg-gray-400" />
                    <p className="text-sm text-gray-900">
                      {entry.from === null
                        ? AFTERSALE_STATUS_TEXT[entry.to]
                        : `${AFTERSALE_STATUS_TEXT[entry.from]} → ${AFTERSALE_STATUS_TEXT[entry.to]}`}
                    </p>
                    <p className="text-xs text-gray-500">
                      {formatDateTime(entry.at)} · {entry.actor}
                    </p>
                    {entry.remark !== null && (
                      <p className="mt-1 text-xs text-gray-600">{entry.remark}</p>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </>
      )}
    </section>
  );
}
