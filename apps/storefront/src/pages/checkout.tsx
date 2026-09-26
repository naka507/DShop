/**
 * 结算 / 下单（`docs/03` §3.5.1「交易 / 结算页 `/checkout`」）。
 *
 * - 按 `merchant_id` 分商户展示（文档硬要求）；
 * - 地址/优惠券/运费试算；
 * - 写操作一律走 API：`POST /api/v1/shop/orders`，**必须带 `Idempotency-Key`**
 *   （`docs/06` §6）。幂等键在**进入页面时生成一次**并保存在 state 中，
 *   使「超时后重试」复用同一个键，不会重复下单（见 `src/lib/idempotency.ts`）。
 */

import type { ReactNode } from "react";
import { useCallback, useState } from "react";
import { useNavigate } from "react-router";

import { createOrder, listAddresses, previewCheckout } from "../api/client.ts";
import type { CheckoutGroup } from "../api/types.ts";
import { PageTitle } from "../components/app-shell.tsx";
import { Empty, ErrorNotice, Loading } from "../components/ui.tsx";
import { useAsync } from "../hooks/use-async.ts";
import { formatPrice, formatSpec } from "../lib/format.ts";
import { newIdempotencyKey } from "../lib/idempotency.ts";

/** 单个商户分组卡片。 */
function GroupCard({ group }: { readonly group: CheckoutGroup }): ReactNode {
  return (
    <div className="rounded border border-gray-200 bg-white p-3">
      <h3 className="mb-2 text-sm font-medium text-gray-900">{group.merchantName}</h3>
      <ul className="divide-y divide-gray-100">
        {group.items.map((item) => (
          <li key={item.id} className="flex justify-between py-2 text-sm">
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
      <p className="mt-2 text-right text-xs text-gray-500">
        商品 {formatPrice(group.goodsAmount)} ＋ 运费 {formatPrice(group.freightAmount)}
      </p>
    </div>
  );
}

/** 结算页。 */
export function CheckoutPage(): ReactNode {
  const navigate = useNavigate();
  const [addressId, setAddressId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<unknown>(null);

  // 幂等键：每次进入结算页生成一次；提交失败重试时复用同一个键。
  const [idempotencyKey] = useState(() => newIdempotencyKey());

  const loadAddresses = useCallback(() => listAddresses(), []);
  const addresses = useAsync(loadAddresses);

  const loadPreview = useCallback(
    () => previewCheckout(addressId === null ? {} : { addressId }),
    [addressId],
  );
  const preview = useAsync(loadPreview);

  const effectiveAddressId =
    addressId ??
    addresses.data?.find((address) => address.isDefault)?.id ??
    addresses.data?.[0]?.id ??
    null;

  const handleSubmit = async (): Promise<void> => {
    if (effectiveAddressId === null) {
      setSubmitError(new Error("请先选择收货地址"));
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const order = await createOrder({ addressId: effectiveAddressId }, idempotencyKey);
      navigate(`/pay/${encodeURIComponent(order.orderNo)}/result`);
    } catch (cause) {
      // 库存不足（ERR_SHOP_*_STOCK_*）等业务错误在此以可操作文案提示。
      setSubmitError(cause);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section>
      <PageTitle>结算</PageTitle>

      <div className="mb-4 rounded border border-gray-200 bg-white p-3">
        <h2 className="mb-2 text-sm font-medium text-gray-900">收货地址</h2>
        {addresses.loading && <Loading label="读取地址…" />}
        {addresses.error !== null && (
          <ErrorNotice error={addresses.error} onRetry={addresses.reload} />
        )}
        {addresses.data !== null && addresses.data.length === 0 && (
          <Empty label="还没有收货地址，请先到「我的 → 地址簿」新增" />
        )}
        {addresses.data !== null && addresses.data.length > 0 && (
          <ul className="space-y-2">
            {addresses.data.map((address) => (
              <li key={address.id}>
                <label className="flex cursor-pointer items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="address"
                    checked={effectiveAddressId === address.id}
                    onChange={() => {
                      setAddressId(address.id);
                    }}
                  />
                  <span>
                    <span className="font-medium text-gray-900">{address.receiverName}</span>
                    <span className="ml-2 text-gray-500">{address.receiverPhone}</span>
                    <span className="ml-2 text-gray-500">
                      {address.province}
                      {address.city}
                      {address.district}
                      {address.detail}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>

      {preview.loading && <Loading label="试算中…" />}
      {preview.error !== null && <ErrorNotice error={preview.error} onRetry={preview.reload} />}
      {preview.data !== null && (
        <>
          <div className="space-y-3">
            {preview.data.groups.map((group) => (
              <GroupCard key={group.merchantId} group={group} />
            ))}
          </div>
          <dl className="mt-4 space-y-1 rounded border border-gray-200 bg-white p-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-gray-500">商品金额</dt>
              <dd>{formatPrice(preview.data.goodsAmount, preview.data.currency)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">运费</dt>
              <dd>{formatPrice(preview.data.freightAmount, preview.data.currency)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">优惠</dt>
              <dd>-{formatPrice(preview.data.discountAmount, preview.data.currency)}</dd>
            </div>
            <div className="flex justify-between border-t border-gray-100 pt-1 text-base font-semibold">
              <dt>应付</dt>
              <dd className="text-red-600">
                {formatPrice(preview.data.payAmount, preview.data.currency)}
              </dd>
            </div>
          </dl>
        </>
      )}

      {submitError !== null && (
        <div className="mt-3">
          <ErrorNotice error={submitError} />
        </div>
      )}

      <button
        type="button"
        disabled={submitting || effectiveAddressId === null || preview.data === null}
        onClick={() => {
          void handleSubmit();
        }}
        className="mt-4 rounded bg-red-600 px-6 py-2 text-sm text-white disabled:opacity-40"
      >
        {submitting ? "提交中…" : "提交订单"}
      </button>
      <p className="mt-2 text-xs text-gray-400">
        提交带 `Idempotency-Key`（`docs/06` §6）：重复点击不会生成重复订单。
      </p>
    </section>
  );
}
