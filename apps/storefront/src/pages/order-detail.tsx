/**
 * 订单详情（`docs/03` §3.5.1「会员 / 订单详情 `/orders/:orderNo`」）。
 *
 * ## ★ 硬要求：主单状态 + 每个子单状态**都必须展示**
 *
 * `docs/08-核心业务流程.md` §8.3 的原始判据是客服场景「买了三件为什么只发一件」——
 * 只展示主单状态就答不出这个问题。因此本页：
 *
 * 1. 顶部展示**主单**状态（`ORDER_STATUS_TEXT`，由后端下发）；
 * 2. 每个子单**单独一行**展示 `subOrderNo` + 子单状态（`SUB_ORDER_STATUS_TEXT`
 *    的文案「待发货 / 已发货 / 已签收 / 已取消」）+ 发货地 + 物流轨迹；
 * 3. 后端未下发 `statusText` 时用 `@dshop/shared` 的 `SUB_ORDER_STATUS_TEXT` 兜底，
 *    避免出现空白状态。
 */

import type { ReactNode } from "react";
import { useCallback } from "react";
import { Link, useParams } from "react-router";

import { SUB_ORDER_STATUS_TEXT } from "@dshop/shared";

import { getOrder } from "../api/client.ts";
import type { OrderSubOrderView } from "../api/types.ts";
import { PageTitle } from "../components/app-shell.tsx";
import { ErrorNotice, Loading, StatusBadge } from "../components/ui.tsx";
import { useAsync } from "../hooks/use-async.ts";
import { formatDateTime, formatPrice, formatSpec } from "../lib/format.ts";

/** 子单状态文案兜底（后端未下发 `statusText` 时使用）。 */
function subOrderStatusText(sub: OrderSubOrderView): string {
  return sub.statusText !== "" ? sub.statusText : SUB_ORDER_STATUS_TEXT[sub.status];
}

/** 单个子单卡片。 */
function SubOrderCard({ sub }: { readonly sub: OrderSubOrderView }): ReactNode {
  return (
    <li className="rounded border border-gray-200 bg-white p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-gray-900">{sub.merchantName}</p>
          <p className="text-xs text-gray-500">子单号：{sub.subOrderNo}</p>
        </div>
        {/* 子单状态单独展示——与主单状态并列，二者都要出现。 */}
        <StatusBadge
          text={subOrderStatusText(sub)}
          tone={
            sub.status === "SHIPPED" ? "info" : sub.status === "COMPLETED" ? "success" : "neutral"
          }
        />
      </div>

      <ul className="mt-2 divide-y divide-gray-100">
        {sub.items.map((item) => (
          <li key={`${sub.subOrderNo}-${item.skuId}`} className="flex justify-between py-1 text-sm">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-gray-900">{item.title}</span>
              <span className="block text-xs text-gray-500">
                {formatSpec(item.spec)} × {item.quantity}
              </span>
            </span>
            <span className="text-gray-700">{formatPrice(item.subtotal)}</span>
          </li>
        ))}
      </ul>

      <p className="mt-2 text-xs text-gray-500">
        发货地：{sub.shipFrom.storeName}（{sub.shipFrom.city}）
      </p>

      {sub.express === null ? (
        <p className="mt-1 text-xs text-gray-400">暂无物流信息</p>
      ) : (
        <div className="mt-2 rounded bg-gray-50 p-2">
          <p className="text-xs text-gray-600">
            {sub.express.company} {sub.express.no} · {sub.express.latestStatus}
          </p>
          <ol className="mt-1 space-y-1">
            {sub.express.traces.map((trace) => (
              <li key={`${trace.time}-${trace.desc}`} className="text-xs text-gray-500">
                <span className="mr-2 text-gray-400">{formatDateTime(trace.time)}</span>
                {trace.desc}
              </li>
            ))}
          </ol>
        </div>
      )}

      {sub.status !== "CANCELLED" && (
        <Link
          to={`/aftersales/apply?orderNo=${encodeURIComponent(sub.subOrderNo.split("-")[0] ?? "")}&subOrderNo=${encodeURIComponent(sub.subOrderNo)}`}
          className="mt-2 inline-block text-xs text-blue-600 hover:underline"
        >
          申请售后
        </Link>
      )}
    </li>
  );
}

/** 订单详情页。 */
export function OrderDetailPage(): ReactNode {
  const params = useParams();
  const orderNo = params.orderNo ?? "";

  const load = useCallback(() => getOrder(orderNo), [orderNo]);
  const { data, error, loading, reload } = useAsync(load, orderNo !== "");

  return (
    <section>
      <PageTitle>订单详情</PageTitle>
      {loading && <Loading />}
      {error !== null && <ErrorNotice error={error} onRetry={reload} />}
      {data !== null && (
        <>
          <div className="rounded border border-gray-200 bg-white p-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm text-gray-500">主单状态</span>
              <StatusBadge
                text={data.statusText}
                tone={
                  data.status === "COMPLETED"
                    ? "success"
                    : data.status === "SHIPPED" || data.status === "PAID"
                      ? "info"
                      : "neutral"
                }
              />
            </div>
            <dl className="mt-3 space-y-1 text-sm">
              <div className="flex gap-3">
                <dt className="w-20 shrink-0 text-gray-500">订单号</dt>
                <dd className="text-gray-900">{data.orderNo}</dd>
              </div>
              <div className="flex gap-3">
                <dt className="w-20 shrink-0 text-gray-500">下单时间</dt>
                <dd className="text-gray-900">{formatDateTime(data.createdAt)}</dd>
              </div>
              <div className="flex gap-3">
                <dt className="w-20 shrink-0 text-gray-500">支付时间</dt>
                <dd className="text-gray-900">{formatDateTime(data.paidAt)}</dd>
              </div>
              <div className="flex gap-3">
                <dt className="w-20 shrink-0 text-gray-500">下单渠道</dt>
                <dd className="text-gray-900">{data.channel}</dd>
              </div>
              <div className="flex gap-3">
                <dt className="w-20 shrink-0 text-gray-500">实付金额</dt>
                <dd className="font-semibold text-red-600">
                  {formatPrice(data.payAmount, data.currency)}
                </dd>
              </div>
              <div className="flex gap-3">
                <dt className="w-20 shrink-0 text-gray-500">收货信息</dt>
                <dd className="text-gray-900">
                  {data.receiver.name} {data.receiver.phone}
                  <br />
                  {data.receiver.province}
                  {data.receiver.city}
                  {data.receiver.district}
                  {data.receiver.detail}
                </dd>
              </div>
              <div className="flex gap-3">
                <dt className="w-20 shrink-0 text-gray-500">售后汇总</dt>
                <dd className="text-gray-900">
                  {data.aftersaleSummary.hasAftersale
                    ? `进行中 ${data.aftersaleSummary.openCount} 笔，已退 ${formatPrice(data.aftersaleSummary.refundedAmount)}`
                    : "无售后记录"}
                </dd>
              </div>
            </dl>
            <Link
              to={`/pay/${encodeURIComponent(data.orderNo)}/result`}
              className="mt-3 inline-block text-sm text-blue-600 hover:underline"
            >
              查看支付状态（实时轮询）
            </Link>
          </div>

          {/* ★ 子单状态区：每个子单都必须出现（docs/08 §8.3）。 */}
          <section className="mt-4">
            <h2 className="mb-2 text-sm font-medium text-gray-900">
              子单状态（共 {data.subOrders.length} 个）
            </h2>
            <ul className="space-y-3">
              {data.subOrders.map((sub) => (
                <SubOrderCard key={sub.subOrderNo} sub={sub} />
              ))}
            </ul>
          </section>
        </>
      )}
    </section>
  );
}
