/**
 * 购物车（`docs/03` §3.5.1「交易 / 购物车 `/cart`」，CSR + 登录后）。
 *
 * 写操作**一律走 API**（`docs/03` §3：SSR 读路径可直连 D1 省一跳，
 * 但所有写操作必须走 `/api/v1/shop/*`）。
 */

import type { ReactNode } from "react";
import { useCallback, useState } from "react";
import { Link } from "react-router";

import { getCart, removeCartItem, updateCartItem } from "../api/client.ts";
import type { CartItemView } from "../api/types.ts";
import { PageTitle } from "../components/app-shell.tsx";
import { Empty, ErrorNotice, Loading } from "../components/ui.tsx";
import { useAsync } from "../hooks/use-async.ts";
import { formatPrice, formatSpec } from "../lib/format.ts";

/** 单行购物车项。 */
function CartRow({
  item,
  onChanged,
  onError,
}: {
  readonly item: CartItemView;
  readonly onChanged: () => void;
  readonly onError: (error: unknown) => void;
}): ReactNode {
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    try {
      await action();
      onChanged();
    } catch (cause) {
      onError(cause);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex flex-wrap items-center gap-3 border-b border-gray-100 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-gray-900">{item.title}</p>
        <p className="mt-1 text-xs text-gray-500">{formatSpec(item.spec)}</p>
        {!item.available && <p className="mt-1 text-xs text-red-600">已下架或售罄，结算前请移除</p>}
      </div>
      <p className="text-sm text-gray-700">{formatPrice(item.unitPrice)}</p>
      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={busy || item.quantity <= 1}
          onClick={() => {
            void run(() => updateCartItem(item.id, item.quantity - 1));
          }}
          className="h-7 w-7 rounded border border-gray-300 disabled:opacity-40"
          aria-label="减少数量"
        >
          −
        </button>
        <span className="w-8 text-center text-sm">{item.quantity}</span>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void run(() => updateCartItem(item.id, item.quantity + 1));
          }}
          className="h-7 w-7 rounded border border-gray-300 disabled:opacity-40"
          aria-label="增加数量"
        >
          +
        </button>
      </div>
      <p className="w-24 text-right text-sm font-semibold text-red-600">
        {formatPrice(item.subtotal)}
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          void run(() => removeCartItem(item.id));
        }}
        className="text-xs text-gray-500 hover:text-red-600 disabled:opacity-40"
      >
        删除
      </button>
    </li>
  );
}

/** 购物车页。 */
export function CartPage(): ReactNode {
  const load = useCallback(() => getCart(), []);
  const { data, error, loading, reload } = useAsync(load);
  const [actionError, setActionError] = useState<unknown>(null);

  const items = data?.items ?? [];
  const availableItems = items.filter((item) => item.available);

  return (
    <section>
      <PageTitle>购物车</PageTitle>
      {actionError !== null && (
        <div className="mb-3">
          <ErrorNotice error={actionError} />
        </div>
      )}
      {loading && <Loading />}
      {error !== null && <ErrorNotice error={error} onRetry={reload} />}
      {data !== null && items.length === 0 && <Empty label="购物车是空的" />}
      {data !== null && items.length > 0 && (
        <>
          <ul>
            {items.map((item) => (
              <CartRow
                key={item.id}
                item={item}
                onChanged={reload}
                onError={(cause) => {
                  setActionError(cause);
                }}
              />
            ))}
          </ul>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-gray-700">
              合计：
              <span className="text-lg font-semibold text-red-600">
                {formatPrice(data.totalAmount, data.currency)}
              </span>
            </p>
            {availableItems.length === 0 ? (
              <p className="text-sm text-gray-400">没有可结算的商品</p>
            ) : (
              <Link to="/checkout" className="rounded bg-red-600 px-6 py-2 text-sm text-white">
                去结算（{availableItems.length} 件）
              </Link>
            )}
          </div>
        </>
      )}
    </section>
  );
}
