/**
 * 通用展示组件（mobile-first，`docs/03-工程结构与前端.md` §3.5.3）。
 *
 * 一律 Tailwind 原子类，断点用默认 `sm/md/lg/xl`；不做 UA 跳转、不做两套模板。
 */

import type { ReactNode } from "react";

import { describeShopError } from "../api/errors.ts";
import type { ProductSummary } from "../api/types.ts";
import { formatPrice } from "../lib/format.ts";

/* -------------------------------------------------------------------------- */
/* 加载 / 错误 / 空态                                                          */
/* -------------------------------------------------------------------------- */

/** 加载中。 */
export function Loading({ label = "加载中…" }: { readonly label?: string }): ReactNode {
  return (
    <p className="py-8 text-center text-sm text-gray-500" role="status">
      {label}
    </p>
  );
}

/** 空态。 */
export function Empty({ label }: { readonly label: string }): ReactNode {
  return <p className="py-8 text-center text-sm text-gray-400">{label}</p>;
}

/**
 * 错误提示。
 *
 * 文案统一经 `describeShopError`（`src/api/errors.ts`），因此 shop 组的
 * **字符串错误码**（`ERR_SHOP_*`）被分流成可操作的中文提示，
 * 不会把原始码直接抛给用户。
 */
export function ErrorNotice({
  error,
  onRetry,
}: {
  readonly error: unknown;
  readonly onRetry?: () => void;
}): ReactNode {
  return (
    <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">
      <p>{describeShopError(error)}</p>
      {onRetry !== undefined && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 rounded border border-red-300 bg-white px-3 py-1 text-red-700"
        >
          重试
        </button>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 商品卡片                                                                    */
/* -------------------------------------------------------------------------- */

/** 商品列表卡片（首页 / 分类 / 搜索共用）。 */
export function ProductCard({ product }: { readonly product: ProductSummary }): ReactNode {
  return (
    <a
      href={`/products/${encodeURIComponent(product.spuId)}`}
      className="block rounded-lg border border-gray-200 p-3 transition hover:shadow-md"
    >
      <div className="mb-2 flex h-32 items-center justify-center overflow-hidden rounded bg-gray-100">
        {product.mainImage === null ? (
          <span className="text-xs text-gray-400">暂无图片</span>
        ) : (
          <img src={product.mainImage} alt={product.title} className="h-full w-full object-cover" />
        )}
      </div>
      <h3 className="line-clamp-2 text-sm font-medium text-gray-900">{product.title}</h3>
      {product.subtitle !== null && (
        <p className="mt-1 text-xs text-gray-500">{product.subtitle}</p>
      )}
      <p className="mt-2 text-base font-semibold text-red-600">
        {formatPrice(product.price, product.currency)}
      </p>
    </a>
  );
}

/** 商品网格（响应式：手机 2 列，平板 3 列，桌面 4 列）。 */
export function ProductGrid({
  products,
}: {
  readonly products: readonly ProductSummary[];
}): ReactNode {
  if (products.length === 0) return <Empty label="暂无商品" />;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {products.map((product) => (
        <ProductCard key={product.spuId} product={product} />
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 状态徽标                                                                    */
/* -------------------------------------------------------------------------- */

/** 主单状态徽标（`ORDER_STATUS_TEXT` 由后端下发，前端只渲染）。 */
export function StatusBadge({
  text,
  tone = "neutral",
}: {
  readonly text: string;
  readonly tone?: "neutral" | "info" | "success" | "warn";
}): ReactNode {
  const toneClass =
    tone === "success"
      ? "bg-green-50 text-green-700 border-green-200"
      : tone === "info"
        ? "bg-blue-50 text-blue-700 border-blue-200"
        : tone === "warn"
          ? "bg-amber-50 text-amber-700 border-amber-200"
          : "bg-gray-50 text-gray-700 border-gray-200";
  return (
    <span className={`inline-block rounded border px-2 py-0.5 text-xs ${toneClass}`}>{text}</span>
  );
}
