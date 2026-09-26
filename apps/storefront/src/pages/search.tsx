/**
 * 搜索列表（`docs/03` §3.5.1「浏览 / 搜索列表 `/search?q=&sort=&page=`」）。
 *
 * 文档明确：**不缓存**（按 `q` 参数化）；后端走 D1 `LIKE` + 分词，升级缝 S5。
 * 因此这里每次 `q` / `sort` / `page` 变化都重新请求，不做本地缓存。
 */

import type { ReactNode } from "react";
import { useCallback } from "react";
import { useSearchParams } from "react-router";

import { listProducts } from "../api/client.ts";
import { PageTitle } from "../components/app-shell.tsx";
import { ErrorNotice, Loading, ProductGrid } from "../components/ui.tsx";
import { useAsync } from "../hooks/use-async.ts";

/** 排序选项（后端 `sort` 参数取值，`docs/06` §6 路由示例）。 */
const SORT_OPTIONS: readonly { readonly value: string; readonly label: string }[] = [
  { value: "", label: "默认" },
  { value: "price_asc", label: "价格升序" },
  { value: "price_desc", label: "价格降序" },
  { value: "newest", label: "最新" },
];

/** 搜索页。 */
export function SearchPage(): ReactNode {
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get("q") ?? "";
  const sort = searchParams.get("sort") ?? "";
  const page = Number(searchParams.get("page") ?? "1") || 1;

  const load = useCallback(() => listProducts({ q, sort, page, pageSize: 20 }), [q, sort, page]);
  const { data, error, loading, reload } = useAsync(load);

  const updateParam = (key: string, value: string): void => {
    const next = new URLSearchParams(searchParams);
    if (value === "") next.delete(key);
    else next.set(key, value);
    // 改条件时回到第 1 页，否则会落在不存在的页码上。
    if (key !== "page") next.delete("page");
    setSearchParams(next);
  };

  return (
    <section>
      <PageTitle>搜索</PageTitle>
      <form
        className="mb-4 flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const input = new FormData(event.currentTarget).get("q");
          updateParam("q", typeof input === "string" ? input : "");
        }}
      >
        <input
          name="q"
          defaultValue={q}
          placeholder="搜索商品"
          aria-label="搜索关键词"
          className="min-w-0 flex-1 rounded border border-gray-300 px-3 py-2 text-sm"
        />
        <select
          value={sort}
          aria-label="排序"
          onChange={(event) => {
            updateParam("sort", event.target.value);
          }}
          className="rounded border border-gray-300 px-3 py-2 text-sm"
        >
          {SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <button type="submit" className="rounded bg-gray-900 px-4 py-2 text-sm text-white">
          搜索
        </button>
      </form>

      {loading && <Loading />}
      {error !== null && <ErrorNotice error={error} onRetry={reload} />}
      {data !== null && (
        <>
          <p className="mb-2 text-sm text-gray-500">
            共 {data.total} 条结果{data.total > 0 ? `，第 ${data.page} 页` : ""}
          </p>
          <ProductGrid products={data.list} />
          {data.total > data.pageSize && (
            <div className="mt-4 flex justify-between text-sm">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => {
                  updateParam("page", String(page - 1));
                }}
                className="rounded border px-3 py-1 disabled:opacity-40"
              >
                上一页
              </button>
              <button
                type="button"
                disabled={page * data.pageSize >= data.total}
                onClick={() => {
                  updateParam("page", String(page + 1));
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
