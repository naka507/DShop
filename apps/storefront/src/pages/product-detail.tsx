/**
 * 商品详情（`docs/03` §3.5.1「浏览 / 商品详情 `/products/:spuId`」）。
 *
 * 文档要求：规格/参数取 `product_attrs` + `product_skus`，与 Agent `/specs`
 * **同源同 Schema**。因此参数分组（含 `IPX5`、使用禁忌等**边界/负面信息**，
 * `docs/M10` §8.7 三条硬性要求）必须完整展示——只列营销卖点会让客服场景失去判据。
 */

import type { ReactNode } from "react";
import { useCallback, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";

import { addCartItem, getProduct } from "../api/client.ts";
import type { ProductSkuView } from "../api/types.ts";
import { PageTitle } from "../components/app-shell.tsx";
import { ErrorNotice, Loading, StatusBadge } from "../components/ui.tsx";
import { useAsync } from "../hooks/use-async.ts";
import { formatPrice, formatSpec } from "../lib/format.ts";

/** 商品详情页。 */
export function ProductDetailPage(): ReactNode {
  const params = useParams();
  const spuId = params.spuId ?? "";
  const navigate = useNavigate();

  const load = useCallback(() => getProduct(spuId), [spuId]);
  const { data, error, loading, reload } = useAsync(load, spuId !== "");

  const [selectedSkuId, setSelectedSkuId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [actionError, setActionError] = useState<unknown>(null);
  const [adding, setAdding] = useState(false);

  const skus = data?.skus ?? [];
  const selectedSku: ProductSkuView | undefined =
    skus.find((sku) => sku.skuId === selectedSkuId) ?? skus[0];

  const handleAddToCart = async (): Promise<void> => {
    if (selectedSku === undefined) return;
    setAdding(true);
    setActionError(null);
    try {
      await addCartItem(selectedSku.skuId, quantity);
      navigate("/cart");
    } catch (cause) {
      // 错误码分流在 ErrorNotice 内完成（ERR_SHOP_* → 可操作提示）。
      setActionError(cause);
    } finally {
      setAdding(false);
    }
  };

  return (
    <section>
      {loading && <Loading />}
      {error !== null && <ErrorNotice error={error} onRetry={reload} />}
      {data !== null && (
        <>
          <PageTitle>{data.title}</PageTitle>
          <div className="grid gap-6 md:grid-cols-2">
            <div className="flex h-64 items-center justify-center rounded-lg bg-gray-100">
              {data.mainImage === null ? (
                <span className="text-sm text-gray-400">暂无图片</span>
              ) : (
                <img
                  src={data.mainImage}
                  alt={data.title}
                  className="h-full w-full rounded-lg object-cover"
                />
              )}
            </div>
            <div>
              {data.subtitle !== null && <p className="text-sm text-gray-500">{data.subtitle}</p>}
              {data.brand !== null && (
                <p className="mt-1 text-sm text-gray-500">品牌：{data.brand}</p>
              )}
              <p className="mt-3 text-2xl font-semibold text-red-600">
                {formatPrice(selectedSku?.price ?? data.price, data.currency)}
              </p>

              <div className="mt-4">
                <h2 className="mb-2 text-sm font-medium text-gray-900">选择规格</h2>
                {skus.length === 0 ? (
                  <p className="text-sm text-gray-400">该商品暂无可售规格</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {skus.map((sku) => (
                      <button
                        key={sku.skuId}
                        type="button"
                        onClick={() => {
                          setSelectedSkuId(sku.skuId);
                        }}
                        disabled={sku.stock <= 0}
                        className={`rounded border px-3 py-1 text-sm disabled:opacity-40 ${
                          sku.skuId === selectedSku?.skuId
                            ? "border-gray-900 bg-gray-900 text-white"
                            : "border-gray-300 text-gray-700"
                        }`}
                      >
                        {formatSpec(sku.spec)}
                        {sku.stock <= 0 ? "（缺货）" : ""}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="mt-4 flex items-center gap-2">
                <label htmlFor="quantity" className="text-sm text-gray-700">
                  数量
                </label>
                <input
                  id="quantity"
                  type="number"
                  min={1}
                  value={quantity}
                  onChange={(event) => {
                    setQuantity(Math.max(1, Number(event.target.value) || 1));
                  }}
                  className="w-20 rounded border border-gray-300 px-2 py-1 text-sm"
                />
              </div>

              {actionError !== null && (
                <div className="mt-3">
                  <ErrorNotice error={actionError} />
                </div>
              )}

              <button
                type="button"
                disabled={adding || selectedSku === undefined || selectedSku.stock <= 0}
                onClick={() => {
                  void handleAddToCart();
                }}
                className="mt-4 rounded bg-red-600 px-6 py-2 text-sm text-white disabled:opacity-40"
              >
                {adding ? "加入中…" : "加入购物车"}
              </button>
              <Link to="/cart" className="ml-4 text-sm text-blue-600 hover:underline">
                去购物车
              </Link>
            </div>
          </div>

          <section className="mt-8">
            <h2 className="mb-3 text-lg font-medium text-gray-900">商品参数</h2>
            {data.attrGroups.length === 0 ? (
              <p className="text-sm text-gray-400">暂无参数</p>
            ) : (
              <div className="space-y-4">
                {data.attrGroups.map((group) => (
                  <div key={group.name} className="rounded border border-gray-200 bg-white p-3">
                    <h3 className="mb-2 text-sm font-medium text-gray-900">{group.name}</h3>
                    <dl className="divide-y divide-gray-100">
                      {group.attrs.map((attr) => (
                        <div key={`${group.name}-${attr.name}`} className="flex gap-4 py-1 text-sm">
                          <dt className="w-32 shrink-0 text-gray-500">{attr.name}</dt>
                          <dd className="text-gray-800">{attr.value}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="mt-6">
            <h2 className="mb-2 text-lg font-medium text-gray-900">商品状态</h2>
            <StatusBadge text={data.status} />
          </section>

          {data.description !== null && (
            <section className="mt-6">
              <h2 className="mb-2 text-lg font-medium text-gray-900">商品详情</h2>
              <p className="whitespace-pre-wrap text-sm text-gray-700">{data.description}</p>
            </section>
          )}
        </>
      )}
    </section>
  );
}
