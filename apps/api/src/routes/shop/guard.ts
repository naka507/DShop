/**
 * shop 组认证守卫与 Cookie 常量（`docs/09` §9.1）。
 *
 * ## 为什么复用 `requireAdminAuth` 的写法而不直接复用中间件
 *
 * `requireAdminAuth` 的**失败码**是 `backofficeErrorForPath(...)` 按路径取表，
 * 因此对 `/api/v1/shop/*` 它本就会取到 `ERR_SHOP_*`；但它的**失败键**是
 * `TOKEN_MISSING` / `TOKEN_INVALID`，而 shop 契约明确要求未登录统一为
 * `ERR_SHOP_UNAUTHORIZED`（`SHOP_ERROR_CODES.UNAUTHORIZED` 的注释：
 * 「`/shop/auth/me` 等需登录端点的统一码」）。故这里写一个 shop 版：
 * **验签与 `aud` 强隔离逻辑逐字照抄** `admin-auth.ts`，只改失败码与 Cookie 名。
 *
 * ## aud 互斥（`docs/09` §9.1）
 *
 * shop 令牌的 `aud` 必须是 `shop`：`verifyJwt(token, secret, { expectedAud: SHOP })`
 * 使 admin / merchant 令牌在 shop 端点一律验签失败；反向亦然
 * （`requireAdminAuth` 只接受 `admin` / `merchant`），因此
 * **shop 令牌访问 `/api/v1/admin/*` 必然 401**。
 *
 * ## Cookie 名（实现侧定案，避免与 admin 组冲突）
 *
 * admin 组用 `dshop_admin_at` / `dshop_admin_rt`，本组用
 * `dshop_shop_at` / `dshop_shop_rt`。文档未定义具体名称。
 */

import { verifyJwt } from "@dshop/auth";
import { JWT_AUDIENCE } from "@dshop/shared";
import type { JwtAudience } from "@dshop/shared";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";

import type { Env } from "../../env.js";
import type { AdminSubject, AppEnv } from "../../lib/context.js";
import { shopUnauthorized } from "./errors.js";

/** C 端 Access Token Cookie 名（实现侧定案）。 */
export const SHOP_ACCESS_COOKIE = "dshop_shop_at";
/** C 端 Refresh Token Cookie 名（实现侧定案；本里程碑不实现 refresh 端点）。 */
export const SHOP_REFRESH_COOKIE = "dshop_shop_rt";

/** shop 组**唯一**允许的 audience（`docs/09` §9.1 的三入口强隔离）。 */
export const SHOP_AUDIENCES: readonly JwtAudience[] = [JWT_AUDIENCE.SHOP];

/** C 端角色 code（`docs/09` §9.1 未定义 C 端角色；实现侧定案为 `customer`）。 */
export const SHOP_ROLE = "customer";

/** 已认证的 C 端主体（写入 `adminSubject`，复用同一变量槽）。 */
export type ShopSubject = AdminSubject;

/**
 * 从请求中提取 access token：优先 `Authorization: Bearer`，回退 Cookie。
 *
 * 与 `extractAccessToken`（admin 版）同序，只是 Cookie 名不同。
 */
export function extractShopAccessToken(c: Context<AppEnv & { Bindings: Env }>): string | null {
  const header = c.req.header("Authorization");
  if (header !== undefined && header.startsWith("Bearer ")) {
    const raw = header.slice("Bearer ".length).trim();
    if (raw.length > 0) return raw;
  }
  const cookie = getCookie(c, SHOP_ACCESS_COOKIE);
  return cookie !== undefined && cookie.length > 0 ? cookie : null;
}

/**
 * 要求已登录的 C 端主体。
 *
 * 校验顺序：存在 token → 验签 → `aud === shop`。
 * 失败**统一**返回 `401` + `ERR_SHOP_UNAUTHORIZED`（不区分「无 token」与
 * 「token 无效」，避免枚举）。
 */
export const requireShopAuth =
  (): MiddlewareHandler<AppEnv & { Bindings: Env }> => async (c, next) => {
    const token = extractShopAccessToken(c);
    if (token === null) return shopUnauthorized("未登录");

    for (const aud of SHOP_AUDIENCES) {
      const payload = await verifyJwt<ShopSubject>(token, c.env.JWT_SECRET, {
        expectedAud: aud,
      });
      if (payload !== null) {
        c.set("adminSubject", payload);
        await next();
        return;
      }
    }

    return shopUnauthorized("登录状态无效或已过期");
  };
