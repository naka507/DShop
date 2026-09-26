/**
 * 首页（`docs/03-工程结构与前端.md` §3.5.1「浏览 / 首页 `/`」）。
 *
 * 理想形态是 SSR + Cache API，楼层/轮播取 `content_blocks`。
 * **本版是 CSR**（见 README「SSR 未落地」）：直接读商品列表，
 * `content_blocks` 楼层属后续项（文档未定义其读端点）。
 */

import type { ReactNode } from "react";
import { useCallback } from "react";
import { Link } from "react-router";

import { listProducts } from "../api/client.ts";
import { PageTitle } from "../components/app-shell.tsx";
import { ErrorNotice, Loading, ProductGrid } from "../components/ui.tsx";
import { useAsync } from "../hooks/use-async.ts";

/** 首页。 */
export function HomePage(): ReactNode {
  const load = useCallback(() => listProducts({ page: 1, pageSize: 20 }), []);
  const { data, error, loading, reload } = useAsync(load);

  return (
    <section>
      <PageTitle>精选商品</PageTitle>
      <p className="mb-4 text-sm text-gray-500">
        浏览类页面按 `docs/03` §3.5.1 应走 SSR + Cache API 保 SEO；当前为 CSR 降级实现。
      </p>
      {loading && <Loading />}
      {error !== null && <ErrorNotice error={error} onRetry={reload} />}
      {data !== null && <ProductGrid products={data.list} />}
      <div className="mt-6 text-sm">
        <Link to="/search" className="text-blue-600 hover:underline">
          去搜索 →
        </Link>
      </div>
    </section>
  );
}
