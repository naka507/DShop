/**
 * TOTP：RFC 6238 / HOTP RFC 4226，**SHA-1 / 6 位 / 30 秒周期 / 允许 ±1 窗口**。
 *
 * 权威来源：M0 简报 §8 第 8 项 —— 「TOTP 算法/位数/步长/恢复码」文档未定义，
 * 实现侧取 **RFC 6238 默认（SHA-1 / 6 位 / 30s）**；恢复码一期不做。
 *
 * 平台管理员**强制** TOTP，商户管理员可选；签发 Agent 服务令牌**强制** TOTP 二次确认
 * （docs/09 §9.1 / 07 §7.8.1）。密钥以 Base32（RFC 4648，大写无 padding）存储于
 * `admin_users.totp_secret`。
 */

import { base32ToBytes, bytesToBase32, randomBytes } from "./encoding.js";
import { hmacSha1 } from "./webcrypto.js";

/** TOTP 周期（秒）。 */
export const TOTP_PERIOD_SECONDS = 30;
/** TOTP 输出位数。 */
export const TOTP_DIGITS = 6;
/** TOTP 摘要算法（RFC 6238 默认）。 */
export const TOTP_ALGORITHM = "SHA-1" as const;
/** 默认允许的窗口偏移（±1 个周期 = ±30s）。 */
export const TOTP_DEFAULT_WINDOW = 1;
/** 密钥字节长度（20 字节 = 160 bit，RFC 4226 §4 R6 推荐长度）。 */
export const TOTP_SECRET_BYTES = 20;
/** 密钥 Base32 文本长度（20 字节 → 32 个 base32 字符，无 padding）。 */
export const TOTP_SECRET_BASE32_LENGTH = 32;

/** 生成 TOTP 密钥：20 字节随机 → Base32（大写无 padding，32 字符）。 */
export function generateTotpSecret(): string {
  return bytesToBase32(randomBytes(TOTP_SECRET_BYTES));
}

/** 校验 Base32 密钥是否合法（可被 `base32ToBytes` 解析且非空）。 */
export function isValidTotpSecret(secret: string): boolean {
  const bytes = base32ToBytes(secret);
  return bytes !== null && bytes.length > 0;
}

function counterBytes(counter: number): Uint8Array {
  const out = new Uint8Array(8);
  // 8 字节大端计数器；高 32 位用除法避免位运算截断。
  const high = Math.floor(counter / 0x100000000);
  const low = counter - high * 0x100000000;
  out[0] = (high >>> 24) & 0xff;
  out[1] = (high >>> 16) & 0xff;
  out[2] = (high >>> 8) & 0xff;
  out[3] = high & 0xff;
  out[4] = (low >>> 24) & 0xff;
  out[5] = (low >>> 16) & 0xff;
  out[6] = (low >>> 8) & 0xff;
  out[7] = low & 0xff;
  return out;
}

function truncateToDigits(digest: Uint8Array, digits: number): string {
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    ((digest[offset + 1] ?? 0) << 16) |
    ((digest[offset + 2] ?? 0) << 8) |
    (digest[offset + 3] ?? 0);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/**
 * 计算指定时间点的 TOTP 码。
 *
 * @param secret Base32 密钥（大小写不敏感、容忍 padding）
 * @param timestampMs Unix 毫秒时间戳（**毫秒**，非秒）
 * @returns 6 位十进制字符串；密钥非法时抛 `TypeError`
 */
export async function totpCode(secret: string, timestampMs: number): Promise<string> {
  const key = base32ToBytes(secret);
  if (key === null || key.length === 0) {
    throw new TypeError("totpCode: 非法 Base32 密钥");
  }
  const counter = Math.floor(timestampMs / 1000 / TOTP_PERIOD_SECONDS);
  const digest = await hmacSha1(key, counterBytes(counter));
  return truncateToDigits(digest, TOTP_DIGITS);
}

/**
 * 校验 TOTP 码（**常量时间**逐窗口比较，任一窗口命中即通过）。
 *
 * @param window 允许的窗口偏移；`0` 表示仅当前窗口，默认 `1`（±30s）
 */
export async function verifyTotp(
  secret: string,
  code: string,
  timestampMs: number = Date.now(),
  window: number = TOTP_DEFAULT_WINDOW,
): Promise<boolean> {
  const normalized = code.replace(/\s/gu, "");
  if (!/^\d{6}$/u.test(normalized)) return false;
  if (!isValidTotpSecret(secret)) return false;

  const safeWindow = Number.isInteger(window) && window >= 0 ? window : TOTP_DEFAULT_WINDOW;
  let matched = 0;
  for (let offset = -safeWindow; offset <= safeWindow; offset += 1) {
    const candidate = await totpCode(secret, timestampMs + offset * TOTP_PERIOD_SECONDS * 1000);
    let diff = 0;
    for (let i = 0; i < TOTP_DIGITS; i += 1) {
      diff |= (candidate.charCodeAt(i) || 0) ^ (normalized.charCodeAt(i) || 0);
    }
    if (diff === 0) matched = 1;
  }
  return matched === 1;
}

/** 生成 `otpauth://` 配置 URI（供二维码录入，RFC 6238 生态通用形态）。 */
export function totpProvisioningUri(secret: string, accountName: string, issuer = "DShop"): string {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
