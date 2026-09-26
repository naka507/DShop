/**
 * 分类页（`docs/03` §3.5.1「浏览 / 分类页 `/categories/:id`」）：
 * `categories` 树 + 商品列表。
 */

import type { ReactNode } from "react";
import { useCallback } from "react";
import { useParams } from "react-router";

import { listCategories, listProducts } from "../api/client.ts";
import { PageTitle } from "../components/app-shell.tsx";
import { ErrorNotice, Loading, ProductGrid } from "../components/ui.tsx";
import { useAsync } from "../hooks/use-async.ts";

/** 分类页。 */
export function CategoryPage(): ReactNode {
  const params = useParams();
  const categoryId = params.id ?? "";

  const loadCategories = useCallback(() => listCategories(), []);
  const categories = useAsync(loadCategories);

  const loadProducts = useCallback(
    () => listProducts({ categoryId, page: 1, pageSize: 20 }),
    [categoryId],
  );
  const products = useAsync(loadProducts, categoryId !== "");

  return (
    <section>
      <PageTitle>分类商品</PageTitle>
      {categories.data !== null && (
        <nav className="mb-4 flex flex-wrap gap-2">
          {categories.data.map((node) => (
            <a
              key={node.id}
              href={`/categories/${encodeURIComponent(node.id)}`}
              className={`rounded border px-3 py-1 text-sm ${
                node.id === categoryId
                  ? "border-gray-900 bg-gray-900 text-white"
                  : "border-gray-200 text-gray-700"
              }`}
            >
              {node.name}
            </a>
          ))}
        </nav>
      )}
      {products.loading && <Loading />}
      {products.error !== null && <ErrorNotice error={products.error} onRetry={products.reload} />}
      {products.data !== null && <ProductGrid products={products.data.list} />}
    </section>
  );
}
