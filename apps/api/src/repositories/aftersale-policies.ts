/**
 * 售后政策仓储（后台维护入口，`docs/06:39` / `docs/09` §9.2）。
 *
 * 列名基准：`packages/db/migrations/0001_init.sql:465-478`。
 * 表结构：
 * `id / category / title / content / version / effective_from / effective_to /
 *  status / tags / created_by / created_at / updated_at`
 *
 * ⚠️ 读路径（Agent 侧 `GET /policies/{category}`）在 `aftersales.ts` 的
 * `findPoliciesByCategory()`；本文件只负责**写**（后台维护语料）。
 */

import type { PolicyCategory, PolicyStatus } from "@dshop/shared";

/** 新建政策的输入。 */
export interface CreatePolicyInput {
  readonly id: string;
  readonly category: PolicyCategory;
  readonly title: string;
  readonly content: string;
  readonly version: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly status: PolicyStatus;
  readonly tags: readonly string[];
  /** 创建人（`admin_users.id`）。 */
  readonly createdBy: string;
  readonly now: string;
}

/** 新建后的行（响应体字段来源）。 */
export interface PolicyCreatedRow {
  readonly id: string;
  readonly category: PolicyCategory;
  readonly title: string;
  readonly version: string;
  readonly status: PolicyStatus;
  readonly effective_from: string;
  readonly effective_to: string | null;
  readonly tags: string;
}

/**
 * 同分类 + 同版本号是否已存在（幂等冲突判据，`ERR_ADMIN_POLICY_VERSION_CONFLICT`）。
 */
export async function policyVersionExists(
  db: D1Database,
  category: string,
  version: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT id FROM aftersale_policies
        WHERE category = ? AND version = ?
        LIMIT 1`,
    )
    .bind(category, version)
    .first<{ id: string }>();
  return row !== null;
}

/**
 * 新建一条售后政策。
 *
 * `status = 'effective'` 且 `effective_from <= now` 的条款才会被
 * `GET /api/v1/agent/policies/{category}` 下发（`aftersales.ts` 的生效判据）。
 */
export async function insertPolicy(
  db: D1Database,
  input: CreatePolicyInput,
): Promise<PolicyCreatedRow> {
  await db
    .prepare(
      `INSERT INTO aftersale_policies
         (id, category, title, content, version, effective_from, effective_to,
          status, tags, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.category,
      input.title,
      input.content,
      input.version,
      input.effectiveFrom,
      input.effectiveTo,
      input.status,
      JSON.stringify(input.tags),
      input.createdBy,
      input.now,
      input.now,
    )
    .run();

  return {
    id: input.id,
    category: input.category,
    title: input.title,
    version: input.version,
    status: input.status,
    effective_from: input.effectiveFrom,
    effective_to: input.effectiveTo,
    tags: JSON.stringify(input.tags),
  };
}
