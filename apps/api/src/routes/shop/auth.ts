/**
 * C 端会员与地址路由（`docs/06` §6 的 `/api/v1/shop/auth/*` 与 `/shop/addresses`）。
 *
 * - `POST /auth/sms-code`  —— 发短信验证码（**免鉴权**）
 * - `POST /auth/login`     —— 登录（**免鉴权**）
 * - `POST /auth/logout`    —— 登出（需鉴权）
 * - `GET  /auth/me`        —— 当前用户（需鉴权）
 * - `GET  /addresses`      —— 收货地址列表（需鉴权）
 *
 * ## 短信通道缺口（如实登记）
 *
 * `docs/09` §9.1 与 `docs/08` §8.1 只定义了「手机号 + 短信验证码（60s 冷却）」的
 * **行为**，**未定义短信服务商**。故本实现**不真的发短信**：
 * 把验证码哈希写入 `settings` 表（见 `repositories/shop-users.ts` 的缺口说明），
 * 并用 `console.warn` 记一条结构化日志。**真实短信通道属后续里程碑。**
 *
 * ## 手机号纪律
 *
 * - 等值查询走 `phone_hash = HMAC-SHA256(PHONE_HASH_PEPPER, 规范化11位)`
 * - 响应与日志**永不出现明文手机号**（响应只出 `phoneMasked`，见 `mappers.ts`）
 * - 库内 `users.phone` 是 AES-GCM 密文（`PHONE_ENC_KEY`）
 *
 * ## Cookie（`docs/09` §9.1）
 *
 * 名称 `dshop_shop_at`（实现侧定案，避开 admin 组的 `dshop_admin_at`），
 * 属性 HttpOnly + Secure + SameSite=Lax + Path=/，与 admin 版逐字一致。
 */

import { ACCESS_TOKEN_TTL_SECONDS, sha256Hex, signJwt } from "@dshop/auth";
import {
  JWT_AUDIENCE,
  ShopAddressListSchema,
  ShopLoginBodySchema,
  ShopLogoutResultSchema,
  ShopSmsCodeBodySchema,
  ShopSmsCodeResultSchema,
  ShopUserSchema,
  newId,
} from "@dshop/shared";
import { Hono } from "hono";
import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";

import type { Env } from "../../env.js";
import type { AppEnv } from "../../lib/context.js";
import { successResponse } from "../../lib/errors.js";
import {
  SMS_CODE_COOLDOWN_SECONDS,
  SMS_CODE_TTL_SECONDS,
  decryptReceiverPhone,
  decryptUserPhone,
  deleteShopSmsCode,
  findOrCreateShopUserByPhone,
  findShopUserById,
  listShopAddresses,
  phoneHashOf,
  readShopSmsCode,
  writeShopSmsCode,
} from "../../repositories/shop-users.js";
import { shopError, shopInvalidParam } from "./errors.js";
import { SHOP_ACCESS_COOKIE, SHOP_ROLE, requireShopAuth } from "./guard.js";
import { mapAddress, maskShopPhone } from "./mappers.js";

export const authRoutes = new Hono<AppEnv & { Bindings: Env }>();

/** 取当前登录用户 id。 */
function currentUserId(c: Context<AppEnv & { Bindings: Env }>): string {
  return c.get("adminSubject").sub;
}

/**
 * 把 Hono 已准备好的响应头（`setCookie()` / `deleteCookie()` 写的那批）
 * 搬到 `successResponse()` 新建的 `Response` 上。
 *
 * ⚠️ 必需：本组的信封由 `lib/errors.ts` 的 `successResponse()` 构造，
 * 它返回**全新的** `Response`，与 Hono 的 `c.res`（`setCookie()` 的落点）不是同一个对象。
 * 不搬的话登录会「成功但没下发 Cookie」——客户端拿不到凭据。
 */
function withPreparedHeaders(c: Context<AppEnv & { Bindings: Env }>, response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of c.res.headers.entries()) {
    // `Set-Cookie` 可能有多条，`Headers.set` 会覆盖，故逐条 append
    if (key.toLowerCase() === "set-cookie") headers.append(key, value);
    else if (!headers.has(key)) headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, headers });
}

/** 读取请求体 JSON；失败返回 `null`。 */

/** 读取请求体 JSON；失败返回 `null`。 */
async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown | null> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

/**
 * 生成 6 位数字验证码（`ShopLoginBodySchema.code` 允许 4–6 位）。
 *
 * ⚠️ **开发模式**：`ENVIRONMENT === "development"` 时固定返回 `123456`，
 * 使本地与测试无需读日志即可登录；其余环境用 WebCrypto 随机。
 */
function generateSmsCode(environment: string | undefined): string {
  if (environment === "development") return "123456";
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const value =
    ((bytes[0] ?? 0) << 24) | ((bytes[1] ?? 0) << 16) | ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0);
  return String(Math.abs(value) % 1_000_000).padStart(6, "0");
}

/* -------------------------------------------------------------------------- */
/* 发验证码（免鉴权）                                                           */
/* -------------------------------------------------------------------------- */

/**
 * `POST /auth/sms-code` —— 发短信验证码。
 *
 * ⚠️ 免鉴权（登录前无可用的凭据）。`docs/08` §8.1 要求：
 * 60s 冷却 + 按 IP / 手机号限流。**冷却**在本端点实现（读上一次发送时间）；
 * IP 维度限流由基础设施（Cloudflare Rate Limiting）承担，不在应用层重复造。
 *
 * 手机号不存在时**同样返回成功**（防账号枚举：不泄露「该号是否已注册」），
 * 且验证码校验阶段会用「建号」语义兜底——C 端登录即注册。
 */
authRoutes.post("/auth/sms-code", async (c) => {
  const raw = await readJson(c);
  if (raw === null) return shopInvalidParam("请求体不是合法 JSON");

  const body = ShopSmsCodeBodySchema.safeParse(raw);
  if (!body.success) return shopInvalidParam("手机号格式非法（须为 11 位且以 1 开头）");

  const identified = await phoneHashOf(body.data.phone, c.env.PHONE_HASH_PEPPER);
  if (identified === null) return shopInvalidParam("手机号格式非法（须为 11 位且以 1 开头）");

  const nowMs = Date.now();
  const existing = await readShopSmsCode(c.env.DB, identified.phoneHash);
  if (existing !== null) {
    const elapsedSeconds = Math.floor((nowMs - existing.sentAtMs) / 1000);
    if (elapsedSeconds < SMS_CODE_COOLDOWN_SECONDS) {
      return shopError(
        "SMS_CODE_RATE_LIMITED",
        `发送过于频繁，请 ${SMS_CODE_COOLDOWN_SECONDS - elapsedSeconds} 秒后重试`,
      );
    }
  }

  const code = generateSmsCode(c.env.ENVIRONMENT);
  const codeHash = await sha256Hex(code);
  await writeShopSmsCode(
    c.env.DB,
    identified.phoneHash,
    { codeHash, sentAtMs: nowMs, expiresAtMs: nowMs + SMS_CODE_TTL_SECONDS * 1000 },
    new Date(nowMs).toISOString(),
  );

  /*
   * ⚠️ **短信通道未接入**（`docs/09` §9.1 未定义服务商）。
   * 结构化日志是 Workers 运行时的唯一出口，此处有意使用 console.warn。
   * **日志里不出现明文手机号**，只出脱敏形态（`docs/07` §7.8.2 的脱敏纪律）。
   */
  console.warn(
    JSON.stringify({
      level: "warn",
      event: "shop_sms_code_not_delivered",
      phoneMasked: maskShopPhone(body.data.phone),
      expiresInSeconds: SMS_CODE_TTL_SECONDS,
      note: "短信通道未接入（后续里程碑），验证码未真实下发",
    }),
  );

  const result = ShopSmsCodeResultSchema.safeParse({ expiresInSeconds: SMS_CODE_TTL_SECONDS });
  if (!result.success) return shopError("INTERNAL_ERROR", "验证码响应不符合契约");
  return successResponse(result.data);
});

/* -------------------------------------------------------------------------- */
/* 登录（免鉴权）                                                               */
/* -------------------------------------------------------------------------- */

/**
 * `POST /auth/login` —— 手机号 + 验证码登录。
 *
 * 成功即签发 `aud = shop` 的 JWT 并写 HttpOnly Cookie。
 * **首次登录自动建号**（`docs/08` §8.1 未定义独立注册端点）。
 */
authRoutes.post("/auth/login", async (c) => {
  const raw = await readJson(c);
  if (raw === null) return shopInvalidParam("请求体不是合法 JSON");

  const body = ShopLoginBodySchema.safeParse(raw);
  if (!body.success) return shopInvalidParam("手机号或验证码格式非法");

  const identified = await phoneHashOf(body.data.phone, c.env.PHONE_HASH_PEPPER);
  if (identified === null) return shopInvalidParam("手机号格式非法（须为 11 位且以 1 开头）");

  const nowMs = Date.now();
  const record = await readShopSmsCode(c.env.DB, identified.phoneHash);
  if (record === null || record.expiresAtMs <= nowMs) {
    return shopError("SMS_CODE_INVALID", "验证码错误或已过期");
  }
  // 常量时间比对无必要（验证码是 6 位短码且已限流），但**不存明文**是硬要求
  const submittedHash = await sha256Hex(body.data.code);
  if (submittedHash !== record.codeHash) {
    return shopError("SMS_CODE_INVALID", "验证码错误或已过期");
  }

  // 校验通过即**一次性作废**验证码（防重放）
  await deleteShopSmsCode(c.env.DB, identified.phoneHash);

  const nowIso = new Date(nowMs).toISOString();
  const user = await findOrCreateShopUserByPhone(c.env.DB, {
    phone: identified.normalized,
    phoneHash: identified.phoneHash,
    phoneEncKey: c.env.PHONE_ENC_KEY,
    newUserId: newId(),
    nowIso,
  });

  // 账号状态校验（`SHOP_ERROR_CODES.ACCOUNT_DISABLED`）
  if (user.status !== "active") {
    return shopError("ACCOUNT_DISABLED", "账号不可用");
  }

  const accessToken = await signJwt({ sub: user.id, role: SHOP_ROLE }, c.env.JWT_SECRET, {
    aud: JWT_AUDIENCE.SHOP,
    expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
    nowMs,
  });

  // Cookie 属性与 admin 组逐字一致（`docs/09` §9.1：HttpOnly + Secure + SameSite=Lax）
  const secure = (c.env.ENVIRONMENT ?? "development") !== "development";
  setCookie(c, SHOP_ACCESS_COOKIE, accessToken, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    maxAge: ACCESS_TOKEN_TTL_SECONDS,
  });

  const plainPhone = await decryptUserPhone(c.env.PHONE_ENC_KEY, user.phone);
  const data = {
    userId: user.id,
    nickname: user.nickname,
    phoneMasked: maskShopPhone(plainPhone),
  };

  const validated = ShopUserSchema.safeParse(data);
  if (!validated.success) return shopError("INTERNAL_ERROR", "登录响应不符合契约");

  /*
   * ⚠️ `successResponse()` 返回的是**新建**的 `Response`，不会自动带上
   * Hono 在 `c.res` 上准备好的 `Set-Cookie`（`setCookie()` 写的是 prepared headers）。
   * 故这里显式把 Cookie 头搬到最终响应上——否则登录成功但**没有下发凭据**。
   */
  return withPreparedHeaders(c, successResponse(validated.data));
});

/* -------------------------------------------------------------------------- */
/* 登出 / 当前用户（需鉴权）                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `POST /auth/logout` —— 登出。
 *
 * ⚠️ **只清 Cookie**：JWT 是无状态短令牌（2h），服务端吊销需黑名单
 * （`docs/04` §4.2 提到 KV 可承载「会话吊销读缓存」，但单一真相源是
 * `refresh_tokens.revoked_at`）。本里程碑**未实现 refresh 端点**，
 * 故没有可吊销的服务端凭据——如实标注，不假装已实现强制下线。
 */
authRoutes.post("/auth/logout", requireShopAuth(), async (c) => {
  deleteCookie(c, SHOP_ACCESS_COOKIE, { path: "/" });
  const result = ShopLogoutResultSchema.safeParse(null);
  if (!result.success) return shopError("INTERNAL_ERROR", "登出响应不符合契约");
  // 同 `/login`：清 Cookie 的头同样需要搬到最终响应上
  return withPreparedHeaders(c, successResponse(result.data));
});

/** `GET /auth/me` —— 当前登录态（未登录 → 401 + `ERR_SHOP_UNAUTHORIZED`）。 */
authRoutes.get("/auth/me", requireShopAuth(), async (c) => {
  const userId = currentUserId(c);
  const user = await findShopUserById(c.env.DB, userId);
  if (user === null) return shopError("TOKEN_INVALID", "账号不存在");
  if (user.status !== "active") return shopError("ACCOUNT_DISABLED", "账号不可用");

  const plainPhone = await decryptUserPhone(c.env.PHONE_ENC_KEY, user.phone);
  const validated = ShopUserSchema.safeParse({
    userId: user.id,
    nickname: user.nickname,
    phoneMasked: maskShopPhone(plainPhone),
  });
  if (!validated.success) return shopError("INTERNAL_ERROR", "当前用户响应不符合契约");

  return successResponse(validated.data);
});

/* -------------------------------------------------------------------------- */
/* 地址簿（需鉴权）                                                             */
/* -------------------------------------------------------------------------- */

/**
 * `GET /addresses` —— 收货地址列表。
 *
 * C 端是地址归属方本人，`receiverPhone` **完整下发**（解密后），
 * 与 Agent 面的脱敏口径不同（`contracts/shop.ts` 文件头）。
 */
authRoutes.get("/addresses", requireShopAuth(), async (c) => {
  const userId = currentUserId(c);
  const rows = await listShopAddresses(c.env.DB, userId);

  const list = await Promise.all(
    rows.map(async (row) =>
      mapAddress(row, await decryptReceiverPhone(c.env.PHONE_ENC_KEY, row.receiver_phone)),
    ),
  );

  const validated = ShopAddressListSchema.safeParse(list);
  if (!validated.success) return shopError("INTERNAL_ERROR", "地址列表响应不符合契约");

  return successResponse(validated.data);
});
