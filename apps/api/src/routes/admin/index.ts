/**
 * 后台登录路由（`docs/09` §9.1）。
 *
 * - `POST /api/v1/admin/login`   —— 账号密码（可选 TOTP）登录，签发 Access + Refresh
 * - `POST /api/v1/admin/refresh` —— 旋转式刷新（旧 refresh 立即吊销并指向新令牌）
 * - `POST /api/v1/admin/logout`  —— 吊销当前 refresh 并清 Cookie
 * - `GET  /api/v1/admin/me`      —— 当前登录身份与权限点（需认证）
 *
 * 安全要点：
 * - 密码用 PBKDF2-SHA256 10 万次（`@dshop/auth` 的 `verifyPassword`），常量时间比对
 * - 连续失败 5 次锁定 15 分钟（阈值与时长为实现侧定案）
 * - Refresh 令牌**只存哈希**（SHA-256 hex），Cookie 为 HttpOnly + Secure + SameSite=Lax
 * - 登录失败**不区分**「用户不存在」与「密码错误」（防账号枚举）
 * - 刷新时主体信息**只以库中 `subject_id` 为准**，不信任客户端传入的任何字段
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
import { AGENT_ERROR_CODES, JWT_AUDIENCE, newId } from "@dshop/shared";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";

import type { Env } from "../../env.js";
import type { AppEnv } from "../../lib/context.js";
import { errorResponse } from "../../lib/errors.js";
import {
  ADMIN_ACCESS_COOKIE,
  ADMIN_REFRESH_COOKIE,
  requireAdminAuth,
} from "../../middleware/admin-auth.js";
import {
  findAdminUserById,
  findAdminUserByUsername,
  findRefreshTokenByHash,
  insertRefreshToken,
  loadAdminIdentity,
  recordLoginFailure,
  recordLoginSuccess,
  revokeRefreshToken,
} from "../../repositories/admin-users.js";

export const adminRoutes = new Hono<AppEnv & { Bindings: Env }>();

/**
 * 同时下发 Access / Refresh 两个 Cookie。
 *
 * `/login` 与 `/refresh` 共用同一段构造逻辑，避免两处属性漂移
 * （曾经 `/refresh` 只重设 refresh Cookie，导致 access Cookie 仍是旧值）。
 */
function setAdminAuthCookies(
  c: Context<AppEnv & { Bindings: Env }>,
  tokens: { readonly accessToken: string; readonly refreshToken: string },
): void {
  const secure = (c.env.ENVIRONMENT ?? "development") !== "development";
  const cookieBase = {
    httpOnly: true,
    secure,
    sameSite: "Lax" as const,
    path: "/",
  };
  setCookie(c, ADMIN_ACCESS_COOKIE, tokens.accessToken, {
    ...cookieBase,
    maxAge: ACCESS_TOKEN_TTL_SECONDS,
  });
  setCookie(c, ADMIN_REFRESH_COOKIE, tokens.refreshToken, {
    ...cookieBase,
    maxAge: REFRESH_TOKEN_TTL_SECONDS,
  });
}

/** 登录失败统一响应（不泄漏账号是否存在）。 */
const loginFailed = (): Response =>
  errorResponse(AGENT_ERROR_CODES.TOKEN_MISSING_OR_INVALID, "账号或密码错误");

interface LoginBody {
  readonly username?: unknown;
  readonly password?: unknown;
  readonly totpCode?: unknown;
}

adminRoutes.post("/login", async (c) => {
  let body: LoginBody;
  try {
    body = (await c.req.json()) as LoginBody;
  } catch {
    return errorResponse(AGENT_ERROR_CODES.INVALID_PARAM, "请求体不是合法 JSON");
  }

  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const totpCode = typeof body.totpCode === "string" ? body.totpCode.trim() : "";

  if (username.length === 0 || password.length === 0) {
    return errorResponse(AGENT_ERROR_CODES.INVALID_PARAM, "账号与密码不能为空");
  }

  const nowMs = Date.now();
  const user = await findAdminUserByUsername(c.env.DB, username);
  if (user === null) return loginFailed();

  if (user.locked_until !== null) {
    const lockedUntilMs = Date.parse(user.locked_until);
    if (Number.isFinite(lockedUntilMs) && lockedUntilMs > nowMs) {
      return errorResponse(
        AGENT_ERROR_CODES.TOKEN_MISSING_OR_INVALID,
        "账号已锁定，请稍后重试",
      );
    }
  }

  if (user.status !== "active") {
    return errorResponse(AGENT_ERROR_CODES.TOKEN_MISSING_OR_INVALID, "账号不可用");
  }

  const passwordOk = await verifyPassword(password, user.password_hash);
  if (!passwordOk) {
    await recordLoginFailure(c.env.DB, user, nowMs);
    return loginFailed();
  }

  if (user.totp_enabled === 1 && user.totp_secret !== null) {
    if (totpCode.length === 0) {
      return errorResponse(AGENT_ERROR_CODES.INVALID_PARAM, "需要动态验证码");
    }
    const totpOk = await verifyTotp(user.totp_secret, totpCode, nowMs);
    if (!totpOk) {
      await recordLoginFailure(c.env.DB, user, nowMs);
      return errorResponse(AGENT_ERROR_CODES.TOKEN_MISSING_OR_INVALID, "动态验证码错误");
    }
  }

  const identity = await loadAdminIdentity(c.env.DB, user);

  // 角色：取首个角色；aud 由角色前缀决定（merchant_* → merchant，否则 admin）
  const primaryRole = identity.roleCodes[0] ?? "platform_operator";
  const aud = primaryRole.startsWith("merchant_")
    ? JWT_AUDIENCE.MERCHANT
    : JWT_AUDIENCE.ADMIN;
  const mid = identity.merchantIds[0];

  const accessToken = await signJwt(
    mid === undefined
      ? { sub: user.id, role: primaryRole }
      : { sub: user.id, role: primaryRole, mid },
    c.env.JWT_SECRET,
    { aud, expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS, nowMs },
  );

  const refreshToken = generateRefreshToken();
  const refreshHash = await hashRefreshToken(refreshToken);
  await insertRefreshToken(c.env.DB, {
    id: newId(),
    subjectType: aud,
    subjectId: user.id,
    tokenHash: refreshHash,
    expiresAt: new Date(nowMs + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString(),
    userAgent: c.req.header("User-Agent") ?? null,
    ip: c.req.header("CF-Connecting-IP") ?? null,
    createdAt: new Date(nowMs).toISOString(),
  });

  await recordLoginSuccess(c.env.DB, user.id, nowMs);

  // 与 `/refresh` 共用同一段 Cookie 构造（属性零漂移）
  setAdminAuthCookies(c, { accessToken, refreshToken });

  return c.json({
    code: AGENT_ERROR_CODES.OK,
    message: "ok",
    data: {
      accessToken,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      subject: {
        id: identity.id,
        username: identity.username,
        nickname: identity.nickname,
        aud,
        role: primaryRole,
        roles: identity.roleCodes,
        permissions: identity.permissions,
        merchantIds: identity.merchantIds,
      },
    },
  });
});

adminRoutes.post("/refresh", async (c) => {
  const refreshToken = getCookie(c, ADMIN_REFRESH_COOKIE);
  if (refreshToken === undefined || refreshToken.length === 0) {
    return errorResponse(AGENT_ERROR_CODES.TOKEN_MISSING_OR_INVALID, "缺少刷新令牌");
  }

  const nowMs = Date.now();
  const hash = await hashRefreshToken(refreshToken);
  const row = await findRefreshTokenByHash(c.env.DB, hash);
  if (row === null) {
    return errorResponse(AGENT_ERROR_CODES.TOKEN_MISSING_OR_INVALID, "刷新令牌无效");
  }
  if (row.revoked_at !== null) {
    return errorResponse(AGENT_ERROR_CODES.TOKEN_REVOKED, "刷新令牌已吊销");
  }
  const expiresMs = Date.parse(row.expires_at);
  if (Number.isFinite(expiresMs) && expiresMs <= nowMs) {
    return errorResponse(AGENT_ERROR_CODES.TOKEN_REVOKED, "刷新令牌已过期");
  }

  // 主体信息只以库中 subject_id 为准，不信任客户端传入的任何字段
  const aud = row.subject_type === JWT_AUDIENCE.MERCHANT
    ? JWT_AUDIENCE.MERCHANT
    : JWT_AUDIENCE.ADMIN;

  const user = await findAdminUserById(c.env.DB, row.subject_id);
  if (user === null) {
    return errorResponse(AGENT_ERROR_CODES.TOKEN_MISSING_OR_INVALID, "账号不存在");
  }
  const identity = await loadAdminIdentity(c.env.DB, user);

  // 与 `/login` 同源：取首个角色作为 access 令牌的 role
  const primaryRole = identity.roleCodes[0] ?? "platform_operator";
  const mid = identity.merchantIds[0];
  const accessToken = await signJwt(
    mid === undefined
      ? { sub: user.id, role: primaryRole }
      : { sub: user.id, role: primaryRole, mid },
    c.env.JWT_SECRET,
    { aud, expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS, nowMs },
  );

  const newRefresh = generateRefreshToken();
  const newHash = await hashRefreshToken(newRefresh);
  const newRefreshId = newId();

  await revokeRefreshToken(c.env.DB, row.id, newRefreshId, new Date(nowMs).toISOString());
  await insertRefreshToken(c.env.DB, {
    id: newRefreshId,
    subjectType: aud,
    subjectId: row.subject_id,
    tokenHash: newHash,
    expiresAt: new Date(nowMs + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString(),
    userAgent: c.req.header("User-Agent") ?? null,
    ip: c.req.header("CF-Connecting-IP") ?? null,
    createdAt: new Date(nowMs).toISOString(),
  });

  // 旋转成功后**同时**重设 access / refresh 两个 Cookie（修复：此前只重设 refresh）
  setAdminAuthCookies(c, { accessToken, refreshToken: newRefresh });

  return c.json({
    code: AGENT_ERROR_CODES.OK,
    message: "ok",
    data: { refreshToken: newRefresh, expiresIn: REFRESH_TOKEN_TTL_SECONDS },
  });
});

adminRoutes.post("/logout", async (c) => {
  const refreshToken = getCookie(c, ADMIN_REFRESH_COOKIE);
  if (refreshToken !== undefined && refreshToken.length > 0) {
    const hash = await hashRefreshToken(refreshToken);
    const row = await findRefreshTokenByHash(c.env.DB, hash);
    if (row !== null && row.revoked_at === null) {
      await revokeRefreshToken(c.env.DB, row.id, null, new Date().toISOString());
    }
  }
  deleteCookie(c, ADMIN_ACCESS_COOKIE, { path: "/" });
  deleteCookie(c, ADMIN_REFRESH_COOKIE, { path: "/" });
  return c.json({
    code: AGENT_ERROR_CODES.OK,
    message: "ok",
    data: { loggedOut: true },
  });
});

adminRoutes.get("/me", requireAdminAuth(), async (c) => {
  const subject = c.get("adminSubject");
  const user = await findAdminUserById(c.env.DB, subject.sub);
  if (user === null) {
    return errorResponse(AGENT_ERROR_CODES.TOKEN_MISSING_OR_INVALID, "账号不存在");
  }
  const identity = await loadAdminIdentity(c.env.DB, user);
  return c.json({
    code: AGENT_ERROR_CODES.OK,
    message: "ok",
    data: {
      id: identity.id,
      username: identity.username,
      nickname: identity.nickname,
      aud: subject.aud,
      role: subject.role,
      roles: identity.roleCodes,
      permissions: identity.permissions,
      merchantIds: identity.merchantIds,
    },
  });
});
