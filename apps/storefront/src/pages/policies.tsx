/**
 * 售后政策页（任务要求；`docs/05-数据模型.md`：`aftersale_policies` 是
 * 「Agent `/policies/{category}` 的唯一来源」）。
 *
 * ## 数据来源
 *
 * `GET /api/v1/agent/policies/:category`（`docs/07` §7.7）。
 * 该端点需要服务令牌，**浏览器不持有令牌**——生产环境必须由 storefront Worker
 * 用 Service Binding 代理该路径（同源转发，见 `src/api/client.ts` 的详细说明）。
 * 因此本页对「该端点不可达」做**显式降级提示**，绝不伪造政策内容。
 *
 * ## 分类
 *
 * 取值来自 `@dshop/shared` 的 `POLICY_QUERY_CATEGORY`（五类 + `all`），
 * 与 Agent 契约的参数枚举同源，避免与后端漂移。
 */

import type { ReactNode } from "react";
import { useCallback, useState } from "react";

import { POLICY_QUERY_CATEGORY, PolicyQueryCategorySchema } from "@dshop/shared";

import { getAftersalePolicies } from "../api/client.ts";
import { describeShopError } from "../api/errors.ts";
import { PageTitle } from "../components/app-shell.tsx";
import { Empty, ErrorNotice, Loading } from "../components/ui.tsx";
import { useAsync } from "../hooks/use-async.ts";
import { formatDateTime } from "../lib/format.ts";
import { renderMarkdown } from "../lib/markdown.tsx";

/** 分类标签（中文展示名；`all` 为聚合查询值，`docs/07` §7.6）。 */
const CATEGORY_LABELS: readonly { readonly value: string; readonly label: string }[] = [
  { value: POLICY_QUERY_CATEGORY.ALL, label: "全部" },
  { value: POLICY_QUERY_CATEGORY.RETURN, label: "退货" },
  { value: POLICY_QUERY_CATEGORY.REFUND, label: "退款" },
  { value: POLICY_QUERY_CATEGORY.EXCHANGE, label: "换货" },
  { value: POLICY_QUERY_CATEGORY.FREIGHT, label: "运费" },
  { value: POLICY_QUERY_CATEGORY.WARRANTY, label: "质保" },
];

/** 售后政策页。 */
export function PoliciesPage(): ReactNode {
  const [category, setCategory] = useState<string>(POLICY_QUERY_CATEGORY.ALL);

  const load = useCallback(() => getAftersalePolicies(category), [category]);
  const { data, error, loading, reload } = useAsync(load);

  // 分类合法性由 shared 的 Schema 判定，防止手拼 URL 传进非法值。
  const categoryValid = PolicyQueryCategorySchema.safeParse(category).success;

  return (
    <section className="mx-auto max-w-3xl">
      <PageTitle>售后政策</PageTitle>
      <p className="mb-4 text-sm text-gray-500">
        内容来自 `aftersale_policies`，与 PiEcho 客服使用同一份政策语料
        （`docs/05-数据模型.md`：该表是 Agent `/policies/&#123;category&#125;` 的唯一来源）。
      </p>

      <nav className="mb-4 flex flex-wrap gap-2">
        {CATEGORY_LABELS.map((item) => (
          <button
            key={item.value}
            type="button"
            onClick={() => {
              setCategory(item.value);
            }}
            className={`rounded border px-3 py-1 text-sm ${
              category === item.value
                ? "border-gray-900 bg-gray-900 text-white"
                : "border-gray-200 text-gray-700"
            }`}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {!categoryValid && <ErrorNotice error={new Error("非法的政策分类")} />}
      {loading && <Loading label="读取政策…" />}
      {error !== null && (
        <>
          <ErrorNotice error={error} onRetry={reload} />
          <p className="mt-2 text-xs text-gray-500">
            该端点需服务令牌，生产环境须由 storefront Worker 同源代理 （`docs/09` §10.2）。
            {describeShopError(error)}
          </p>
        </>
      )}
      {data !== null && data.items.length === 0 && <Empty label="该分类暂无生效条款" />}
      {data !== null && data.items.length > 0 && (
        <>
          <p className="mb-3 text-xs text-gray-400">内容指纹 contentHash：{data.contentHash}</p>
          <div className="space-y-4">
            {data.items.map((item) => (
              <article key={item.policyId} className="rounded border border-gray-200 bg-white p-4">
                <h2 className="text-base font-semibold text-gray-900">{item.title}</h2>
                <p className="mt-1 text-xs text-gray-400">
                  版本 {item.version} · 生效 {formatDateTime(item.effectiveFrom)}
                  {item.effectiveTo !== null ? ` ~ ${formatDateTime(item.effectiveTo)}` : ""} ·
                  更新于 {formatDateTime(item.updatedAt)}
                </p>
                <div className="mt-3 text-sm leading-relaxed text-gray-800">
                  {renderMarkdown(item.content)}
                </div>
                {item.tags.length > 0 && (
                  <p className="mt-2 flex flex-wrap gap-1">
                    {item.tags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600"
                      >
                        {tag}
                      </span>
                    ))}
                  </p>
                )}
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
