/**
 * 商户组的鉴权守卫（`docs/09` §9.1 的 `aud` 强隔离 + `MERCHANT_ERROR_CODES`）。
 *
 * ## 为什么不直接用 `requireAdminAuth()`
 *
 * `middleware/admin-auth.ts` 的 `requireAdminAuth()` 是**三组共用**的（shop / admin /
 * merchant），它按路径取错误码表，故商户路径下「未登录」得到的是
 * `ERR_MERCHANT_TOKEN_MISSING`。而 `MERCHANT_ERROR_CODES.UNAUTHORIZED`
 * （`packages/shared/src/errors.ts`）的注释写明它是「与 `TOKEN_MISSING` 同语义的**别名**，
 * 便于前端统一判定」——商户后台契约要求「未登录」统一为 `ERR_MERCHANT_UNAUTHORIZED`。
 *
 * 本文件因此把该差异收拢到商户组自己的守卫里，**不改动共享中间件**
 * （那会波及 admin / shop 两组，且 `middleware/**` 不在本任务的文件所有权内）。
 *
 * 复用点：`extractAccessToken()`（`Authorization: Bearer` → Cookie 回退）与
 * `verifyJwt()`（`aud` 强隔离）都是既有导出，行为与平台入口**逐字一致**。
 */

import { verifyJwt } from "@dshop/auth";
import { JWT_AUDIENCE, MERCHANT_ERROR_CODES } from "@dshop/shared";
import type { JwtAudience } from "@dshop/shared";
import type { MiddlewareHandler } from "hono";

import type { Env } from "../../env.js";
import type { AdminSubject, AppEnv } from "../../lib/context.js";
import { backofficeErrorResponse } from "../../lib/errors.js";
import { extractAccessToken } from "../../middleware/admin-auth.js";

/** 商户组默认允许的受众：平台侧可见全部，商户侧被 `merchantScope` 收敛（`docs/09` §9.2）。 */
export const MERCHANT_AUDIENCES: readonly JwtAudience[] = [
  JWT_AUDIENCE.ADMIN,
  JWT_AUDIENCE.MERCHANT,
];

/**
 * 要求已登录的商户组主体。
 *
 * - **缺凭据** → `401` + `ERR_MERCHANT_UNAUTHORIZED`（别名码，见文件头注释）
 * - **凭据无效 / `aud` 不在允许集合** → `401` + `ERR_MERCHANT_TOKEN_INVALID`
 *   （不区分「无 token」与「token 无效」，避免枚举）
 */
export const requireMerchantAuth =
  (
    allowedAudiences: readonly JwtAudience[] = MERCHANT_AUDIENCES,
  ): MiddlewareHandler<AppEnv & { Bindings: Env }> =>
  async (c, next) => {
    const token = extractAccessToken(c);
    if (token === null) {
      return backofficeErrorResponse(MERCHANT_ERROR_CODES.UNAUTHORIZED, "未登录");
    }

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

    return backofficeErrorResponse(MERCHANT_ERROR_CODES.TOKEN_INVALID, "登录状态无效或已过期");
  };
