/**
 * PiEcho 运营入口①：Agent 服务令牌签发 / 吊销（`docs/06:37-38`、`docs/09` §9.2、`docs/07` §7.8.1）。
 *
 * - `POST /api/v1/admin/agent-tokens`              —— 签发（**强制 TOTP**）
 * - `POST /api/v1/admin/agent-tokens/:id/revoke`   —— 吊销（立即生效）
 *
 * ## 权限与二次验证
 *
 * 两条端点都要求权限点 `agent:token:manage`（`docs/09` §9.2）。
 * 签发额外**强制 TOTP 二次验证**（`docs/09:34`：「两个 PiEcho 专属权限点都属角色 A 的
 * 运营能力，**M0 必须有后台入口**」；明文令牌仅返回一次，泄露需立刻止损）。
 *
 * ## 令牌存储（`docs/07` §7.8.1）
 *
 * - 明文格式 `dshop_svc_<24 位 base62>_<6 位校验>`（`@dshop/auth` 的 `generateServiceToken()`）
 * - 落库只存 `token_hash = HMAC-SHA256(AGENT_TOKEN_PEPPER, token)`（hex）
 * - `token_prefix` = 明文前 16 位（查询加速，**不是**安全边界）
 * - 明文**仅在签发响应里返回一次**，此后任何接口都无法取回
 *
 * ## 审计
 *
 * 两次写操作都落 `audit_logs`（`docs/09` §9.2：「后台所有写操作落 audit_logs」）。
 * `after` 里**绝不含明文令牌**，只有 `token_prefix`。
 *
 * ## 错误码
 *
 * 全部字符串码（`ADMIN_ERROR_CODES`，`docs/README.md:34`）。
 */

import {
  generateServiceToken,
  hashServiceToken,
  serviceTokenPrefix,
  verifyTotp,
} from "@dshop/auth";
import {
  ADMIN_ERROR_CODES,
  AdminAgentTokenIssueBodySchema,
  AdminAgentTokenRevokeBodySchema,
  AdminAgentTokenRevokeParamsSchema,
  PERMISSIONS,
  SERVICE_TOKEN_STATUS,
  newId,
} from "@dshop/shared";
import { Hono } from "hono";

import type { Env } from "../../env.js";
import type { AppEnv } from "../../lib/context.js";
import { backofficeErrorResponse } from "../../lib/errors.js";
import { requireAdminAuth } from "../../middleware/admin-auth.js";
import { requirePermission } from "../../middleware/rbac.js";
import { AUDIT_ACTOR_TYPE, insertAuditLog } from "../../repositories/audit-logs.js";
import { findAdminUserById } from "../../repositories/admin-users.js";
import {
  findServiceTokenById,
  insertServiceToken,
  revokeServiceToken,
} from "../../repositories/service-tokens.js";

export const agentTokenAdminRoutes = new Hono<AppEnv & { Bindings: Env }>();

/** 解析请求体 JSON；失败返回 `null`（调用方回 400）。 */
async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown | null> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* 签发                                                                        */
/* -------------------------------------------------------------------------- */

agentTokenAdminRoutes.post(
  "/agent-tokens",
  requireAdminAuth(),
  requirePermission(PERMISSIONS.AGENT_TOKEN_MANAGE),
  async (c) => {
    const raw = await readJson(c);
    if (raw === null) {
      return backofficeErrorResponse(ADMIN_ERROR_CODES.INVALID_PARAM, "请求体不是合法 JSON");
    }

    const parsed = AdminAgentTokenIssueBodySchema.safeParse(raw);
    if (!parsed.success) {
      return backofficeErrorResponse(
        ADMIN_ERROR_CODES.INVALID_PARAM,
        parsed.error.issues[0]?.message ?? "参数校验失败",
      );
    }
    const body = parsed.data;

    const subject = c.get("adminSubject");
    const nowMs = Date.now();

    // 强制 TOTP 二次验证：签发是高风险操作（明文仅返回一次）
    const operator = await findAdminUserById(c.env.DB, subject.sub);
    if (operator === null) {
      return backofficeErrorResponse(ADMIN_ERROR_CODES.TOKEN_INVALID, "账号不存在");
    }
    if (operator.totp_enabled !== 1 || operator.totp_secret === null) {
      // 未启用 TOTP 的账号不得签发令牌——否则「强制二次验证」形同虚设
      return backofficeErrorResponse(
        ADMIN_ERROR_CODES.TOTP_REQUIRED,
        "该账号未启用动态验证码，无法签发 Agent 令牌",
      );
    }
    const totpOk = await verifyTotp(operator.totp_secret, body.totpCode, nowMs);
    if (!totpOk) {
      return backofficeErrorResponse(ADMIN_ERROR_CODES.TOTP_INVALID, "动态验证码错误");
    }

    const token = generateServiceToken();
    const tokenHash = await hashServiceToken(c.env.AGENT_TOKEN_PEPPER, token);
    const tokenPrefix = serviceTokenPrefix(token);
    const id = newId();
    const nowIso = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + body.expiresInDays * 24 * 60 * 60 * 1000).toISOString();

    await insertServiceToken(c.env.DB, {
      id,
      tokenHash,
      tokenPrefix,
      name: body.name,
      scopes: body.scopes,
      expiresAt,
      rateLimitPerMin: body.rateLimitPerMin,
      createdBy: subject.sub,
      rotatedFrom: null,
      createdAt: nowIso,
    });

    // 审计：`after` 只记前缀与元信息，**绝不含明文令牌**
    await insertAuditLog(c.env.DB, {
      actorType: AUDIT_ACTOR_TYPE.ADMIN,
      actorId: subject.sub,
      action: "agent_token.issue",
      targetType: "service_token",
      targetId: id,
      before: null,
      after: {
        name: body.name,
        tokenPrefix,
        scopes: body.scopes,
        expiresAt,
        rateLimitPerMin: body.rateLimitPerMin,
      },
      ip: c.req.header("CF-Connecting-IP") ?? null,
      userAgent: c.req.header("User-Agent") ?? null,
      createdAt: nowIso,
    });

    return c.json({
      code: 0,
      message: "ok",
      data: {
        id,
        name: body.name,
        tokenPrefix,
        scopes: body.scopes,
        expiresAt,
        rateLimitPerMin: body.rateLimitPerMin,
        // 明文**仅此一次**（`docs/09:127`：「明文仅返回一次 → 安全渠道交付 PiEcho」）
        token,
      },
    });
  },
);

/* -------------------------------------------------------------------------- */
/* 吊销                                                                        */
/* -------------------------------------------------------------------------- */

agentTokenAdminRoutes.post(
  "/agent-tokens/:id/revoke",
  requireAdminAuth(),
  requirePermission(PERMISSIONS.AGENT_TOKEN_MANAGE),
  async (c) => {
    const params = AdminAgentTokenRevokeParamsSchema.safeParse(c.req.param());
    if (!params.success) {
      return backofficeErrorResponse(ADMIN_ERROR_CODES.INVALID_PARAM, "令牌 id 格式非法");
    }

    // 请求体可选（reason）；空体也接受
    const rawBody = await readJson(c);
    const parsedBody = AdminAgentTokenRevokeBodySchema.safeParse(rawBody ?? {});
    if (!parsedBody.success) {
      return backofficeErrorResponse(
        ADMIN_ERROR_CODES.INVALID_PARAM,
        parsedBody.error.issues[0]?.message ?? "参数校验失败",
      );
    }

    const subject = c.get("adminSubject");
    const nowIso = new Date().toISOString();

    const row = await findServiceTokenById(c.env.DB, params.data.id);
    if (row === null) {
      return backofficeErrorResponse(
        ADMIN_ERROR_CODES.AGENT_TOKEN_NOT_FOUND,
        "Agent 服务令牌不存在",
      );
    }
    if (row.status === SERVICE_TOKEN_STATUS.REVOKED || row.revoked_at !== null) {
      return backofficeErrorResponse(
        ADMIN_ERROR_CODES.AGENT_TOKEN_ALREADY_REVOKED,
        "Agent 服务令牌已吊销",
      );
    }

    await revokeServiceToken(c.env.DB, params.data.id, subject.sub, nowIso);

    await insertAuditLog(c.env.DB, {
      actorType: AUDIT_ACTOR_TYPE.ADMIN,
      actorId: subject.sub,
      action: "agent_token.revoke",
      targetType: "service_token",
      targetId: params.data.id,
      before: { status: row.status, tokenPrefix: row.token_prefix },
      after: {
        status: SERVICE_TOKEN_STATUS.REVOKED,
        reason: parsedBody.data.reason ?? null,
      },
      ip: c.req.header("CF-Connecting-IP") ?? null,
      userAgent: c.req.header("User-Agent") ?? null,
      createdAt: nowIso,
    });

    return c.json({
      code: 0,
      message: "ok",
      data: {
        id: params.data.id,
        status: SERVICE_TOKEN_STATUS.REVOKED,
        revokedAt: nowIso,
      },
    });
  },
);
