/**
 * JWT：HS256（WebCrypto HMAC-SHA256）。
 *
 * 权威来源：`docs/09-认证权限与部署.md` §9.1 —— 载荷 `sub / aud / role / mid`，有效期 2h；
 * 刷新令牌 14d（不落在本文件，见 `refresh-token.ts`）。
 *
 * 强隔离（§9.1）：`aud` 三取值 `shop` / `admin` / `merchant` 互不通用；
 * 调用方用 `expectedAud` 显式声明本入口期望的受众，不符一律 `null`。
 *
 * ⚠️ 文档未定义项：`iat / exp / nbf / jti` 与签发端点（M0 简报 §8 第 6 项）。
 * 本文件定案：签发 `iat`（秒）、`exp`（秒）、`jti`（随机 base64url 16 字节）；
 * **不签发 `nbf`**（一期不需要延迟生效语义）。
 */

import { JWT_AUDIENCE, type JwtAudience } from "@dshop/shared";

import { base64UrlToBytes, bytesToBase64Url, bytesToUtf8, constantTimeEqual, randomBytes, utf8ToBytes } from "./encoding.js";
import { hmacSha256 } from "./webcrypto.js";

/** 算法标识（JOSE `alg`）。 */
export const JWT_ALGORITHM = "HS256" as const;

/** Access Token 有效期：**2 小时**（docs/09 §9.1）。 */
export const ACCESS_TOKEN_TTL_SECONDS = 2 * 3600;
/** Refresh Token 有效期：**14 天**（docs/09 §9.1）。 */
export const REFRESH_TOKEN_TTL_SECONDS = 14 * 24 * 3600;

/** JWT Header（固定 `typ: JWT`）。 */
export const JWT_HEADER = { alg: JWT_ALGORITHM, typ: "JWT" } as const;

/** 校验后的完整载荷。 */
export interface JwtPayload {
  /** 主体标识：用户 ULID / 后台账号 id / 商户成员 id。 */
  readonly sub: string;
  /** 受众，决定该 Token 只能访问哪个入口命名空间。 */
  readonly aud: JwtAudience;
  /** 角色 code（`PLATFORM_ROLE` / `MERCHANT_ROLE` 之一，或 C 端固定值）。 */
  readonly role: string;
  /** 商户 id（`aud = merchant` 时必填；其余可空）。 */
  readonly mid?: string;
  /** 签发时间（**秒级** Unix 时间戳）。 */
  readonly iat: number;
  /** 过期时间（**秒级** Unix 时间戳）。 */
  readonly exp: number;
  /** Token 唯一标识（便于吊销黑名单与审计）。 */
  readonly jti: string;
}

/** 调用方需提供的载荷部分（`iat` / `exp` / `jti` 由签发器生成）。 */
export interface JwtPayloadInput {
  readonly sub: string;
  readonly role: string;
  readonly mid?: string;
}

/** 签发选项。 */
export interface SignJwtOptions {
  /** 受众（必填，取 `JWT_AUDIENCE`）。 */
  readonly aud: JwtAudience;
  /** 有效期（秒）；默认 `ACCESS_TOKEN_TTL_SECONDS`（2h）。 */
  readonly expiresInSeconds?: number;
  /** 当前时间（**毫秒**）；默认 `Date.now()`，测试可注入。 */
  readonly nowMs?: number;
  /** 指定 `jti`；默认随机 16 字节 base64url。 */
  readonly jti?: string;
}

/** 验签选项。 */
export interface VerifyJwtOptions {
  /** 期望受众；提供且不符 → `null`（三入口强隔离）。 */
  readonly expectedAud?: JwtAudience;
  /** 当前时间（**毫秒**）；默认 `Date.now()`，测试可注入。 */
  readonly nowMs?: number;
  /** 允许的时钟偏移（秒），默认 0。 */
  readonly clockToleranceSeconds?: number;
}

const JWT_AUDIENCES: readonly string[] = Object.values(JWT_AUDIENCE);

function isJwtAudience(value: unknown): value is JwtAudience {
  return typeof value === "string" && JWT_AUDIENCES.includes(value);
}

function base64UrlJson(value: unknown): string {
  return bytesToBase64Url(utf8ToBytes(JSON.stringify(value)));
}

async function signParts(secret: string, signingInput: string): Promise<string> {
  const signature = await hmacSha256(secret, signingInput);
  return bytesToBase64Url(signature);
}

/**
 * 签发 HS256 JWT。
 *
 * @param payload 载荷主体（`sub` / `role` / `mid?`）
 * @param secret `JWT_SECRET`（32 字节随机，docs/09 §9.1）
 * @param options 受众与 TTL（必填 `aud`）
 */
export async function signJwt(
  payload: JwtPayloadInput,
  secret: string,
  options: SignJwtOptions,
): Promise<string> {
  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const ttl = options.expiresInSeconds ?? ACCESS_TOKEN_TTL_SECONDS;
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new RangeError(`signJwt: expiresInSeconds 必须为正数，收到 ${String(ttl)}`);
  }
  if (!isJwtAudience(options.aud)) {
    throw new TypeError(`signJwt: 非法 aud ${String(options.aud)}`);
  }

  const claims: Record<string, unknown> = {
    sub: payload.sub,
    aud: options.aud,
    role: payload.role,
    iat: nowSeconds,
    exp: nowSeconds + Math.floor(ttl),
    jti: options.jti ?? bytesToBase64Url(randomBytes(16)),
  };
  if (payload.mid !== undefined && payload.mid !== "") claims.mid = payload.mid;

  const signingInput = `${base64UrlJson(JWT_HEADER)}.${base64UrlJson(claims)}`;
  const signature = await signParts(secret, signingInput);
  return `${signingInput}.${signature}`;
}

/**
 * 验签并返回载荷；**任何失败（结构/编码/算法/签名/`exp`/`aud`）返回 `null`，不抛**。
 */
export async function verifyJwt<T = JwtPayload>(
  token: string,
  secret: string,
  options: VerifyJwtOptions = {},
): Promise<T | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts;
  if (headerPart === undefined || payloadPart === undefined || signaturePart === undefined) {
    return null;
  }
  if (headerPart === "" || payloadPart === "" || signaturePart === "") return null;

  const headerBytes = base64UrlToBytes(headerPart);
  const payloadBytes = base64UrlToBytes(payloadPart);
  if (headerBytes === null || payloadBytes === null) return null;

  let header: unknown;
  let claims: unknown;
  try {
    header = JSON.parse(bytesToUtf8(headerBytes));
    claims = JSON.parse(bytesToUtf8(payloadBytes));
  } catch {
    return null;
  }

  if (typeof header !== "object" || header === null) return null;
  if ((header as { alg?: unknown }).alg !== JWT_ALGORITHM) return null;

  const expectedSignature = await signParts(secret, `${headerPart}.${payloadPart}`);
  if (!constantTimeEqual(expectedSignature, signaturePart)) return null;

  if (typeof claims !== "object" || claims === null) return null;
  const record = claims as Record<string, unknown>;

  if (typeof record.exp !== "number" || !Number.isFinite(record.exp)) return null;
  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const tolerance = options.clockToleranceSeconds ?? 0;
  if (nowSeconds > record.exp + tolerance) return null;

  if (typeof record.iat === "number" && record.iat - tolerance > nowSeconds) return null;

  if (!isJwtAudience(record.aud)) return null;
  if (options.expectedAud !== undefined && record.aud !== options.expectedAud) return null;

  if (typeof record.sub !== "string" || record.sub === "") return null;

  return record as T;
}

/** 不验签地读出载荷（仅用于诊断/日志，**禁止**用于鉴权决策）。 */
export function decodeJwtUnsafe(token: string): JwtPayload | null {
  const parts = token.split(".");
  const payloadPart = parts[1];
  if (payloadPart === undefined) return null;
  const bytes = base64UrlToBytes(payloadPart);
  if (bytes === null) return null;
  try {
    const parsed: unknown = JSON.parse(bytesToUtf8(bytes));
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as JwtPayload;
  } catch {
    return null;
  }
}
