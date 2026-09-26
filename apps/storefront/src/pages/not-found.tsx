/**
 * 404 页。
 *
 * 声明式路由下未匹配的路径会落到这里（`src/routes.tsx` 的 `path="*"`）。
 * SSR（framework mode）下这应当由服务端返回 404 状态码；
 * **SPA 降级方案无法设置 HTTP 状态码**——这是 README「SSR 未落地」里
 * 如实列出的影响之一（SEO / 状态码）。
 */

import type { ReactNode } from "react";
import { Link } from "react-router";

/** 404 页。 */
export function NotFoundPage(): ReactNode {
  return (
    <section className="py-12 text-center">
      <h1 className="text-2xl font-semibold text-gray-900">页面不存在</h1>
      <p className="mt-2 text-sm text-gray-500">你访问的地址没有对应的页面。</p>
      <Link to="/" className="mt-4 inline-block rounded bg-gray-900 px-4 py-2 text-sm text-white">
        回到首页
      </Link>
    </section>
  );
}
