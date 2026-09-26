/**
 * 商户入口会话（`POST /merchant/login`、`/refresh`、`/logout`、`GET /merchant/me`）。
 *
 * 权威依据：
 * - `docs/03` §3.5.2：商户入口与平台入口**接口不同、Token `aud` 不同、权限集不同**
 * - `docs/09` §9.1：`aud = merchant`、Access 2h、Refresh 14d 旋转式
 * - `docs/08` §8.1：账号 + 密码（PBKDF2）+ TOTP（**商户管理员可选**），连续失败 5 次锁 15 分钟
 * - `packages/shared/src/contracts/merchant.ts` 的 `MerchantLogin*` / `MerchantSubject` Schema
 *
 * ## 与 `/admin/login` 的差异（同一账号体系，不同入口）
 *
 * | 项 | 平台入口 | 商户入口（本文件） |
 * | --- | --- | --- |
 * | `aud` | `admin`（无 `merchant_*` 角色时） | **恒为 `merchant`** |
 * | 准入条件 | 平台角色即可 | **必须**在 `merchant_members` 中有 `status = active` 的关联 |
 * | TOTP | 平台管理员强制 | **可选**（启用才校验，`docs/08` §8.1） |
 *
 * 错误码一律字符串（`MERCHANT_ERROR_CODES`，`docs/README.md:34`）。
 */

import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  generateRefreshToken,
  hashRefreshToken,
  signJwt,
  verifyPassword,
  verifyTotp,
} from "@dshop/auth";
import {
  JWT_AUDIENCE,
  MERCHANT_ERROR_CODES,
  MERCHANT_ROLE,
  MerchantLoginBodySchema,
  MerchantRefreshBodySchema,
  newId,
} from "@dshop/shared";
import { Hono } from "hono";
import { deleteCookie, generateCookie, getCookie } from "hono/cookie";
import type { Context } from "hono";

import type { Env } from "../../env.js";
import type { AppEnv } from "../../lib/context.js";
import { backofficeErrorResponse, successResponse } from "../../lib/errors.js";
import { ADMIN_ACCESS_COOKIE, ADMIN_REFRESH_COOKIE } from "../../middleware/admin-auth.js";
import { requireMerchantAuth } from "./guards.js";
import {
  findAdminUserById,
  findAdminUserByUsername,
  findMerchantIdsForAdmin,
  findRefreshTokenByHash,
  insertRefreshToken,
  loadAdminIdentity,
  recordLoginFailure,
  recordLoginSuccess,
  revokeRefreshToken,
} from "../../repositories/admin-users.js";

export const merchantAuthRoutes = new Hono<AppEnv & { Bindings: Env }>();

/**
 * 构造两个认证 Cookie 的 `Set-Cookie` 值。
 *
 * Cookie 名与平台入口**相同**（`dshop_admin_at` / `dshop_admin_rt`）：
 * `docs/09` §9.1 只说「各入口域名独立（`admin` / `merchant` Cookie 互不可见）」，
 * **未定义 Cookie 名**；两个入口部署在不同域（`docs/09` §10.3 步骤 5），
 * Cookie 天然隔离，复用同名可让读取路径与前端客户端保持一致。
 *
 * ⚠️ **不能直接用 `hono/cookie` 的 `setCookie(c, …)`**：它把值写进 Hono 的
 * `c.header()` 缓冲，而本文件的响应由 `successResponse()` 返回一个**全新的
 * `Response` 对象**——Hono 不会把缓冲合并进去，Cookie 会被静默丢弃
 * （这是本实现修复的真实缺陷，由 `merchant-routes.test.ts` 的
 * 「合法凭据 → 200 + 两个 Set-Cookie」用例锁死）。
 *
 * 故这里用 `generateCookie()` 只**生成**字符串，再经 `withSetCookie()` 注入
 * （`Headers` 对同名键会合并，多条 `Set-Cookie` 必须用 `append()`）。
 */
function buildAuthCookies(
  c: Context<AppEnv & { Bindings: Env }>,
  tokens: { readonly accessToken: string; readonly refreshToken: string },
): readonly string[] {
  const secure = (c.env.ENVIRONMENT ?? "development") !== "development";
  const cookieBase = {
    httpOnly: true,
    secure,
    sameSite: "Lax" as const,
    path: "/",
  };
  return [
    generateCookie(ADMIN_ACCESS_COOKIE, tokens.accessToken, {
      ...cookieBase,
      maxAge: ACCESS_TOKEN_TTL_SECONDS,
    }),
    generateCookie(ADMIN_REFRESH_COOKIE, tokens.refreshToken, {
      ...cookieBase,
      maxAge: REFRESH_TOKEN_TTL_SECONDS,
    }),
  ];
}

/**
 * 把 `Set-Cookie` 数组附加到统一信封响应上。
 *
 * `Headers#append("Set-Cookie", …)` 在 workerd / Node 22 下会保留多条同名头，
 * 这正是多 Cookie 的正确落地方式（`new Headers({ "Set-Cookie": a })` 会被合并成一条）。
 */
function withSetCookie(response: Response, cookies: readonly string[]): Response {
  for (const cookie of cookies) response.headers.append("Set-Cookie", cookie);
  return response;
}

/** 登录失败统一响应（不区分「账号不存在」与「密码错误」，防账号枚举）。 */
const loginFailed = (): Response =>
  backofficeErrorResponse(MERCHANT_ERROR_CODES.TOKEN_INVALID, "账号或密码错误");

/**
 * 商户侧主角色：优先 `merchant_admin`，否则回退 `merchant_staff`。
 *
 * ⚠️ **文档未定义**商户入口的 `role` 取值来源；`MERCHANT_ROLE`（`packages/shared/src/rbac.ts`）
 * 只给了 `merchant_admin` / `merchant_staff` 两个 code。实现侧定案：按该账号在
 * `merchant_members` 中的 `role`（`owner`/`manager` → `merchant_admin`，`staff` → `merchant_staff`）
 * 推导，取首条关联。
 */
async function resolveMerchantRole(db: D1Database, adminUserId: string): Promise<string> {
  const row = await db
    .prepare(
      `SELECT role FROM merchant_members
        WHERE admin_user_id = ? AND status = 'active'
        ORDER BY created_at ASC LIMIT 1`,
    )
    .bind(adminUserId)
    .first<{ role: string }>();
  if (row === null) return MERCHANT_ROLE.ADMIN;
  return row.role === "staff" ? MERCHANT_ROLE.STAFF : MERCHANT_ROLE.ADMIN;
}

/* -------------------------------------------------------------------------- */
/* POST /merchant/login                                                        */
/* -------------------------------------------------------------------------- */

merchantAuthRoutes.post("/login", async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return backofficeErrorResponse(MERCHANT_ERROR_CODES.INVALID_PARAM, "请求体不是合法 JSON");
  }

  const parsed = MerchantLoginBodySchema.safeParse(raw);
  if (!parsed.success) {
    return backofficeErrorResponse(
      MERCHANT_ERROR_CODES.INVALID_PARAM,
      parsed.error.issues[0]?.message ?? "参数校验失败",
    );
  }
  const body = parsed.data;
  const nowMs = Date.now();

  const user = await findAdminUserByUsername(c.env.DB, body.username);
  if (user === null) return loginFailed();

  if (user.locked_until !== null) {
    const lockedUntilMs = Date.parse(user.locked_until);
    if (Number.isFinite(lockedUntilMs) && lockedUntilMs > nowMs) {
      return backofficeErrorResponse(MERCHANT_ERROR_CODES.ACCOUNT_LOCKED, "账号已锁定，请稍后重试");
    }
  }

  if (user.status !== "active") {
    return backofficeErrorResponse(MERCHANT_ERROR_CODES.ACCOUNT_DISABLED, "账号不可用");
  }

  const passwordOk = await verifyPassword(body.password, user.password_hash);
  if (!passwordOk) {
    await recordLoginFailure(c.env.DB, user, nowMs);
    return loginFailed();
  }

  // TOTP：商户管理员**可选**启用（`docs/08` §8.1），启用才强制校验
  if (user.totp_enabled === 1 && user.totp_secret !== null) {
    if (body.totpCode === undefined) {
      return backofficeErrorResponse(MERCHANT_ERROR_CODES.TOTP_REQUIRED, "需要动态验证码");
    }
    const totpOk = await verifyTotp(user.totp_secret, body.totpCode, nowMs);
    if (!totpOk) {
      await recordLoginFailure(c.env.DB, user, nowMs);
      return backofficeErrorResponse(MERCHANT_ERROR_CODES.TOTP_INVALID, "动态验证码错误");
    }
  }

  // 准入：必须是某商户的 active 成员，否则不得进入商户入口
  const merchantIds = await findMerchantIdsForAdmin(c.env.DB, user.id);
  if (merchantIds.length === 0) {
    return backofficeErrorResponse(MERCHANT_ERROR_CODES.PERMISSION_DENIED, "该账号未关联任何商户");
  }

  const identity = await loadAdminIdentity(c.env.DB, user);
  const role = await resolveMerchantRole(c.env.DB, user.id);
  const mid = merchantIds[0];

  const accessToken = await signJwt({ sub: user.id, role, mid }, c.env.JWT_SECRET, {
    aud: JWT_AUDIENCE.MERCHANT,
    expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
    nowMs,
  });

  const refreshToken = generateRefreshToken();
  await insertRefreshToken(c.env.DB, {
    id: newId(),
    subjectType: JWT_AUDIENCE.MERCHANT,
    subjectId: user.id,
    tokenHash: await hashRefreshToken(refreshToken),
    expiresAt: new Date(nowMs + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString(),
    userAgent: c.req.header("User-Agent") ?? null,
    ip: c.req.header("CF-Connecting-IP") ?? null,
    createdAt: new Date(nowMs).toISOString(),
  });

  await recordLoginSuccess(c.env.DB, user.id, nowMs);

  return withSetCookie(
    successResponse({
      accessToken,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      subject: {
        id: identity.id,
        username: identity.username,
        nickname: identity.nickname ?? identity.username,
        aud: JWT_AUDIENCE.MERCHANT,
        role,
        roles: identity.roleCodes,
        permissions: identity.permissions,
        merchantIds,
      },
    }),
    buildAuthCookies(c, { accessToken, refreshToken }),
  );
});

/* -------------------------------------------------------------------------- */
/* POST /merchant/refresh                                                      */
/* -------------------------------------------------------------------------- */

merchantAuthRoutes.post("/refresh", async (c) => {
  let body: { readonly refreshToken?: unknown } = {};
  try {
    body = (await c.req.json()) as { readonly refreshToken?: unknown };
  } catch {
    // 空体 / 非 JSON 体都接受：Web 走 Cookie，小程序 / APP 走请求体（契约已声明可选）
  }
  const parsedBody = MerchantRefreshBodySchema.safeParse(body);
  if (!parsedBody.success) {
    return backofficeErrorResponse(
      MERCHANT_ERROR_CODES.INVALID_PARAM,
      parsedBody.error.issues[0]?.message ?? "参数校验失败",
    );
  }

  // 请求体优先（小程序 / APP），回退 Cookie（Web）
  const refreshToken = parsedBody.data.refreshToken ?? getCookie(c, ADMIN_REFRESH_COOKIE) ?? "";
  if (refreshToken.length === 0) {
    return backofficeErrorResponse(MERCHANT_ERROR_CODES.TOKEN_MISSING, "缺少刷新令牌");
  }

  const nowMs = Date.now();
  const row = await findRefreshTokenByHash(c.env.DB, await hashRefreshToken(refreshToken));
  if (row === null) {
    return backofficeErrorResponse(MERCHANT_ERROR_CODES.TOKEN_INVALID, "刷新令牌无效");
  }
  if (row.revoked_at !== null) {
    return backofficeErrorResponse(MERCHANT_ERROR_CODES.TOKEN_REVOKED, "刷新令牌已吊销");
  }
  const expiresMs = Date.parse(row.expires_at);
  if (Number.isFinite(expiresMs) && expiresMs <= nowMs) {
    return backofficeErrorResponse(MERCHANT_ERROR_CODES.TOKEN_REVOKED, "刷新令牌已过期");
  }
  // aud 互斥：平台入口的 refresh 令牌不得在商户入口换发令牌（`docs/09` §9.1）
  if (row.subject_type !== JWT_AUDIENCE.MERCHANT) {
    return backofficeErrorResponse(MERCHANT_ERROR_CODES.TOKEN_INVALID, "刷新令牌不属于商户入口");
  }

  const user = await findAdminUserById(c.env.DB, row.subject_id);
  if (user === null) {
    return backofficeErrorResponse(MERCHANT_ERROR_CODES.TOKEN_INVALID, "账号不存在");
  }
  const merchantIds = await findMerchantIdsForAdmin(c.env.DB, user.id);
  if (merchantIds.length === 0) {
    return backofficeErrorResponse(MERCHANT_ERROR_CODES.PERMISSION_DENIED, "该账号未关联任何商户");
  }

  const identity = await loadAdminIdentity(c.env.DB, user);
  const role = await resolveMerchantRole(c.env.DB, user.id);
  const accessToken = await signJwt({ sub: user.id, role, mid: merchantIds[0] }, c.env.JWT_SECRET, {
    aud: JWT_AUDIENCE.MERCHANT,
    expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
    nowMs,
  });

  const newRefresh = generateRefreshToken();
  const newRefreshId = newId();
  await revokeRefreshToken(c.env.DB, row.id, newRefreshId, new Date(nowMs).toISOString());
  await insertRefreshToken(c.env.DB, {
    id: newRefreshId,
    subjectType: JWT_AUDIENCE.MERCHANT,
    subjectId: row.subject_id,
    tokenHash: await hashRefreshToken(newRefresh),
    expiresAt: new Date(nowMs + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString(),
    userAgent: c.req.header("User-Agent") ?? null,
    ip: c.req.header("CF-Connecting-IP") ?? null,
    createdAt: new Date(nowMs).toISOString(),
  });

  return withSetCookie(
    successResponse({
      accessToken,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      subject: {
        id: identity.id,
        username: identity.username,
        nickname: identity.nickname ?? identity.username,
        aud: JWT_AUDIENCE.MERCHANT,
        role,
        roles: identity.roleCodes,
        permissions: identity.permissions,
        merchantIds,
      },
    }),
    buildAuthCookies(c, { accessToken, refreshToken: newRefresh }),
  );
});

/* -------------------------------------------------------------------------- */
/* POST /merchant/logout                                                       */
/* -------------------------------------------------------------------------- */

merchantAuthRoutes.post("/logout", async (c) => {
  const refreshToken = getCookie(c, ADMIN_REFRESH_COOKIE);
  if (refreshToken !== undefined && refreshToken.length > 0) {
    const row = await findRefreshTokenByHash(c.env.DB, await hashRefreshToken(refreshToken));
    if (row !== null && row.revoked_at === null) {
      await revokeRefreshToken(c.env.DB, row.id, null, new Date().toISOString());
    }
  }
  deleteCookie(c, ADMIN_ACCESS_COOKIE, { path: "/" });
  deleteCookie(c, ADMIN_REFRESH_COOKIE, { path: "/" });
  return successResponse({ loggedOut: true });
});

/* -------------------------------------------------------------------------- */
/* GET /merchant/me                                                            */
/* -------------------------------------------------------------------------- */

/**
 * 当前商户主体。
 *
 * ⚠️ **`aud` 只接受 `merchant`**：`docs/09` §9.1 的 `aud` 强隔离明确
 * 「`admin` Token 访问 `/merchant/*` 亦 `401`」。故平台令牌在此返回 `401`
 * （码为 `ERR_MERCHANT_TOKEN_INVALID`），**不放行**。
 */
merchantAuthRoutes.get("/me", requireMerchantAuth([JWT_AUDIENCE.MERCHANT]), async (c) => {
  const subject = c.get("adminSubject");
  const user = await findAdminUserById(c.env.DB, subject.sub);
  if (user === null) {
    return backofficeErrorResponse(MERCHANT_ERROR_CODES.TOKEN_INVALID, "账号不存在");
  }
  const identity = await loadAdminIdentity(c.env.DB, user);
  return successResponse({
    id: identity.id,
    username: identity.username,
    nickname: identity.nickname ?? identity.username,
    aud: JWT_AUDIENCE.MERCHANT,
    role: subject.role,
    roles: identity.roleCodes,
    permissions: identity.permissions,
    merchantIds: identity.merchantIds,
  });
});
