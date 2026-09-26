/**
 * 售后申请（`docs/03` §3.5.1「会员 / 售后申请 `/aftersales/apply?orderNo=`」）。
 *
 * - 仅退款 / 退货退款（`AFTERSALE_TYPE`）；
 * - 凭证上传：文档要求**预签名直传 R2**（`docs/03` §3.5.1），本版只提交
 *   `evidenceKeys`（对象键），预签名接口文档未定义 → 见 README「未实现项」；
 * - `POST /api/v1/shop/aftersales` 必须带 `Idempotency-Key`（`docs/06` §6），
 *   键在进入页面时生成一次并在重试间复用。
 */

import type { ReactNode } from "react";
import { useCallback, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { AFTERSALE_TYPE, AFTERSALE_TYPE_TEXT, ORDER_NO_PATTERN } from "@dshop/shared";

import { applyAftersale, getOrder } from "../api/client.ts";
import type { OrderSubOrderView } from "../api/types.ts";
import { PageTitle } from "../components/app-shell.tsx";
import { Empty, ErrorNotice, Loading } from "../components/ui.tsx";
import { useAsync } from "../hooks/use-async.ts";
import { formatPrice } from "../lib/format.ts";
import { newIdempotencyKey } from "../lib/idempotency.ts";

/** 售后类型选项（取值来自 `@dshop/shared`，避免与后端漂移）。 */
const TYPE_OPTIONS: readonly { readonly value: string; readonly label: string }[] = [
  { value: AFTERSALE_TYPE.REFUND_ONLY, label: AFTERSALE_TYPE_TEXT[AFTERSALE_TYPE.REFUND_ONLY] },
  { value: AFTERSALE_TYPE.RETURN_REFUND, label: AFTERSALE_TYPE_TEXT[AFTERSALE_TYPE.RETURN_REFUND] },
];

/** 售后申请页。 */
export function AftersaleApplyPage(): ReactNode {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const orderNo = searchParams.get("orderNo") ?? "";
  const subOrderNo = searchParams.get("subOrderNo") ?? "";

  const [type, setType] = useState<string>(AFTERSALE_TYPE.REFUND_ONLY);
  const [reason, setReason] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [idempotencyKey] = useState(() => newIdempotencyKey());

  const orderNoValid = ORDER_NO_PATTERN.test(orderNo);
  const load = useCallback(() => getOrder(orderNo), [orderNo]);
  const { data, error, loading, reload } = useAsync(load, orderNoValid);

  // 只允许对当前订单中存在的子单申请售后。
  const targetSub: OrderSubOrderView | undefined =
    data?.subOrders.find((sub) => sub.subOrderNo === subOrderNo) ?? data?.subOrders[0];
  const targetItem = targetSub?.items[0];

  const handleSubmit = async (): Promise<void> => {
    if (targetSub === undefined || targetItem === undefined) {
      setSubmitError(new Error("请选择要申请售后的商品"));
      return;
    }
    if (reason.trim() === "") {
      setSubmitError(new Error("请填写售后原因"));
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const detail = await applyAftersale(
        {
          orderNo,
          subOrderNo: targetSub.subOrderNo,
          skuId: targetItem.skuId,
          quantity,
          type:
            type === AFTERSALE_TYPE.RETURN_REFUND
              ? AFTERSALE_TYPE.RETURN_REFUND
              : AFTERSALE_TYPE.REFUND_ONLY,
          reason: reason.trim(),
        },
        idempotencyKey,
      );
      navigate(`/aftersales/${encodeURIComponent(detail.aftersaleNo)}`);
    } catch (cause) {
      setSubmitError(cause);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="mx-auto max-w-2xl">
      <PageTitle>申请售后</PageTitle>
      {!orderNoValid && <ErrorNotice error={new Error("缺少或非法的订单号（应为 ^DS\\d{17}$）")} />}
      {loading && <Loading />}
      {error !== null && <ErrorNotice error={error} onRetry={reload} />}

      {data !== null && targetSub === undefined && <Empty label="该订单没有可申请售后的子单" />}

      {data !== null && targetSub !== undefined && targetItem !== undefined && (
        <>
          <div className="rounded border border-gray-200 bg-white p-3 text-sm">
            <p className="text-gray-500">订单号：{data.orderNo}</p>
            <p className="mt-1 text-gray-500">子单号：{targetSub.subOrderNo}</p>
            <p className="mt-1 text-gray-900">{targetItem.title}</p>
            <p className="mt-1 text-xs text-gray-500">
              单价 {formatPrice(targetItem.unitPrice)} × {targetItem.quantity}
            </p>
          </div>

          <fieldset className="mt-4">
            <legend className="text-sm font-medium text-gray-900">售后类型</legend>
            <div className="mt-2 flex gap-4">
              {TYPE_OPTIONS.map((option) => (
                <label key={option.value} className="flex items-center gap-1 text-sm">
                  <input
                    type="radio"
                    name="type"
                    value={option.value}
                    checked={type === option.value}
                    onChange={() => {
                      setType(option.value);
                    }}
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </fieldset>

          <label htmlFor="quantity" className="mt-4 block text-sm text-gray-700">
            售后数量
          </label>
          <input
            id="quantity"
            type="number"
            min={1}
            max={targetItem.quantity}
            value={quantity}
            onChange={(event) => {
              const next = Number(event.target.value) || 1;
              setQuantity(Math.min(Math.max(1, next), targetItem.quantity));
            }}
            className="mt-1 w-24 rounded border border-gray-300 px-2 py-1 text-sm"
          />

          <label htmlFor="reason" className="mt-4 block text-sm text-gray-700">
            售后原因
          </label>
          <textarea
            id="reason"
            value={reason}
            rows={4}
            onChange={(event) => {
              setReason(event.target.value);
            }}
            placeholder="请描述问题（如：耳机进水后单耳无声）"
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
          />

          <p className="mt-2 text-xs text-gray-400">
            凭证上传需走预签名直传 R2（`docs/03`
            §3.5.1）；预签名端点文档未定义，本版暂不提供上传入口。
          </p>

          {submitError !== null && (
            <div className="mt-3">
              <ErrorNotice error={submitError} />
            </div>
          )}

          <button
            type="button"
            disabled={submitting}
            onClick={() => {
              void handleSubmit();
            }}
            className="mt-4 rounded bg-red-600 px-6 py-2 text-sm text-white disabled:opacity-40"
          >
            {submitting ? "提交中…" : "提交申请"}
          </button>
        </>
      )}
    </section>
  );
}
