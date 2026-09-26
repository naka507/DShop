/**
 * PiEcho 运营入口②：售后政策语料维护（`docs/06:39`、`docs/09` §9.2）。
 *
 * - `POST /api/v1/admin/aftersale-policies` —— 新建/发布政策条款
 *
 * ## 为什么必须有
 *
 * `docs/09:34`：「两个 PiEcho 专属权限点（`agent:token:manage`、
 * `aftersale:policy:manage`）都属角色 A 的运营能力，**M0 必须有后台入口**——
 * 否则 PiEcho 拿不到令牌、**政策语料无法维护**，联调无法开始（P1）。」
 *
 * 写入的 `content` 由 `GET /api/v1/agent/policies/{category}`（`docs/07` §7.7）
 * **逐字下发**，PiEcho 据此切片入向量库。
 *
 * ## 权限
 *
 * 需权限点 `aftersale:policy:manage`（`docs/09` §9.2；平台超管与平台运营均持有）。
 *
 * ## 错误码
 *
 * 字符串码 `ADMIN_ERROR_CODES`（`docs/README.md:34`）。
 */

import {
  ADMIN_ERROR_CODES,
  AdminAftersalePolicyCreateBodySchema,
  PERMISSIONS,
  newId,
} from "@dshop/shared";
import { Hono } from "hono";

import type { Env } from "../../env.js";
import type { AppEnv } from "../../lib/context.js";
import { backofficeErrorResponse } from "../../lib/errors.js";
import { requireAdminAuth } from "../../middleware/admin-auth.js";
import { requirePermission } from "../../middleware/rbac.js";
import { insertPolicy, policyVersionExists } from "../../repositories/aftersale-policies.js";
import { AUDIT_ACTOR_TYPE, insertAuditLog } from "../../repositories/audit-logs.js";
import { parseStringArray } from "../../repositories/json.js";

export const aftersalePolicyAdminRoutes = new Hono<AppEnv & { Bindings: Env }>();

aftersalePolicyAdminRoutes.post(
  "/aftersale-policies",
  requireAdminAuth(),
  requirePermission(PERMISSIONS.AFTERSALE_POLICY_MANAGE),
  async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return backofficeErrorResponse(ADMIN_ERROR_CODES.INVALID_PARAM, "请求体不是合法 JSON");
    }

    const parsed = AdminAftersalePolicyCreateBodySchema.safeParse(raw);
    if (!parsed.success) {
      return backofficeErrorResponse(
        ADMIN_ERROR_CODES.INVALID_PARAM,
        parsed.error.issues[0]?.message ?? "参数校验失败",
      );
    }
    const body = parsed.data;

    // 同分类 + 同版本号唯一：避免 PiEcho 侧向量库出现两条同版本政策
    if (await policyVersionExists(c.env.DB, body.category, body.version)) {
      return backofficeErrorResponse(
        ADMIN_ERROR_CODES.POLICY_VERSION_CONFLICT,
        `分类 ${body.category} 已存在版本 ${body.version}`,
      );
    }

    const subject = c.get("adminSubject");
    const nowIso = new Date().toISOString();
    const id = newId();

    const row = await insertPolicy(c.env.DB, {
      id,
      category: body.category,
      title: body.title,
      content: body.content,
      version: body.version,
      effectiveFrom: body.effectiveFrom,
      effectiveTo: body.effectiveTo,
      status: body.status,
      tags: body.tags,
      createdBy: subject.sub,
      now: nowIso,
    });

    // 审计：`after` 记元信息与正文长度，**不整段复制正文**（正文可能很长）
    await insertAuditLog(c.env.DB, {
      actorType: AUDIT_ACTOR_TYPE.ADMIN,
      actorId: subject.sub,
      action: "aftersale_policy.create",
      targetType: "aftersale_policy",
      targetId: id,
      before: null,
      after: {
        category: body.category,
        title: body.title,
        version: body.version,
        status: body.status,
        effectiveFrom: body.effectiveFrom,
        effectiveTo: body.effectiveTo,
        tags: body.tags,
        contentLength: body.content.length,
      },
      ip: c.req.header("CF-Connecting-IP") ?? null,
      userAgent: c.req.header("User-Agent") ?? null,
      createdAt: nowIso,
    });

    return c.json({
      code: 0,
      message: "ok",
      data: {
        id: row.id,
        category: row.category,
        title: row.title,
        version: row.version,
        status: row.status,
        effectiveFrom: row.effective_from,
        effectiveTo: row.effective_to,
        tags: parseStringArray(row.tags),
      },
    });
  },
);
