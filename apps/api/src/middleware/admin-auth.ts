/**
 * 后台 JWT 认证中间件（`docs/09` §9.1）。
 *
 * - Access Token 走 `Authorization: Bearer <jwt>`
 * - Refresh Token 走 **HttpOnly + Secure + SameSite=Lax Cookie**（不可被 JS 读取）
 * - `aud` 强隔离：后台管理端点只接受 `admin`/`merchant`，顾客侧只接受 `shop`
 *
 * ⚠️ Cookie 名称文档未定义，实现侧定案并登记：
 * - Access：`dshop_admin_at`
 * - Refresh：`dshop_admin_rt`
 */

import { verifyJwt } from "@dshop/auth";
import { JWT_AUDIENCE } from "@dshop/shared";
import type { JwtAudience } from "@dshop/shared";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";

import type { Env } from "../env.js";
import type { AdminSubject, AppEnv } from "../lib/context.js";
import { backofficeErrorForPath } from "../lib/errors.js";

/** Access Token Cookie 名（实现侧定案）。 */
export const ADMIN_ACCESS_COOKIE = "dshop_admin_at";
/** Refresh Token Cookie 名（实现侧定案）。 */
export const ADMIN_REFRESH_COOKIE = "dshop_admin_rt";

/** 后台组允许的 audience。 */
export const ADMIN_AUDIENCES: readonly JwtAudience[] = [JWT_AUDIENCE.ADMIN, JWT_AUDIENCE.MERCHANT];

/**
 * 从请求中提取 access token：优先 `Authorization: Bearer`，回退 Cookie。
 */
export function extractAccessToken(c: Context<AppEnv & { Bindings: Env }>): string | null {
  const header = c.req.header("Authorization");
  if (header !== undefined && header.startsWith("Bearer ")) {
    const raw = header.slice("Bearer ".length).trim();
    if (raw.length > 0) return raw;
  }
  const cookie = getCookie(c, ADMIN_ACCESS_COOKIE);
  return cookie !== undefined && cookie.length > 0 ? cookie : null;
}

/**
 * 要求已登录的后台主体。
 *
 * 校验顺序：存在 token → 验签 → `aud` 合法 → 命中允许集合。
 * 失败统一 401（不区分「无 token」与「token 无效」，避免枚举）。
 *
 * ⚠️ **错误码为字符串**（`docs/README.md:34`：shop/admin/merchant 用字符串码）——
 * 具体取 `ERR_ADMIN_*` 还是 `ERR_MERCHANT_*` 由请求路径前缀决定
 * （`backofficeErrorForPath`，`docs/06:11-13`）。
 */
export const requireAdminAuth =
  (
    allowedAudiences: readonly JwtAudience[] = ADMIN_AUDIENCES,
  ): MiddlewareHandler<AppEnv & { Bindings: Env }> =>
  async (c, next) => {
    const token = extractAccessToken(c);
    if (token === null) {
      return backofficeErrorForPath(c.req.path, "TOKEN_MISSING", "未登录");
    }

    // 逐个允许的 aud 验签（verifyJwt 支持 expectedAud 强隔离）
    for (const aud of allowedAudiences) {
      const payload = await verifyJwt<AdminSubject>(token, c.env.JWT_SECRET, {
        expectedAud: aud,
      });
      if (payload !== null) {
        c.set("adminSubject", payload);
        await next();
        return;
      }
    }

    return backofficeErrorForPath(c.req.path, "TOKEN_INVALID", "登录状态无效或已过期");
  };
