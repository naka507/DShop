/**
 * 刷新令牌：随机不透明串 + SHA-256 哈希落库（**旋转式**）。
 *
 * 权威来源：`docs/09-认证权限与部署.md` §9.1 —— 「Refresh Token 随机串，D1 存哈希，
 * 有效期 14d，**旋转式**（每次刷新作废旧 token），支持管理端强制吊销」。
 *
 * 落库表：`refresh_tokens`（05 §5.2）。哈希用 **SHA-256**（不是 HMAC）——文档原文只说
 * 「D1 存哈希」，且刷新令牌是 32 字节高熵随机串，无需 pepper 抗暴力。
 *
 * ⚠️ 文档未定义项：刷新端点路径与响应格式（M0 简报 §8 第 5 项）。本文件只管串与哈希，
 * 端点与 Cookie 由 `apps/api` 决定（Cookie：HttpOnly + Secure + SameSite=Lax，三入口独立命名）。
 */

import { bytesToBase64Url, bytesToHex, randomBytes } from "./encoding.js";
import { sha256Bytes } from "./webcrypto.js";

/** 刷新令牌随机字节长度。 */
export const REFRESH_TOKEN_BYTES = 32;
/** 刷新令牌明文长度（32 字节 base64url 无 padding = 43 字符）。 */
export const REFRESH_TOKEN_LENGTH = 43;
/** 刷新令牌明文正则（base64url，43 字符）。 */
export const REFRESH_TOKEN_REGEX = /^[A-Za-z0-9_-]{43}$/u;

/** 生成刷新令牌明文（32 字节随机 → base64url 无 padding）。 */
export function generateRefreshToken(): string {
  return bytesToBase64Url(randomBytes(REFRESH_TOKEN_BYTES));
}

/** 刷新令牌哈希：`SHA-256(token)` 的 **hex（小写）**——即 `refresh_tokens.token_hash`。 */
export async function hashRefreshToken(token: string): Promise<string> {
  return bytesToHex(await sha256Bytes(token));
}

/** 结构校验（仅格式，不代表令牌有效）。 */
export function isRefreshTokenFormat(token: string): boolean {
  return REFRESH_TOKEN_REGEX.test(token);
}
