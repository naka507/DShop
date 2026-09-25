/**
 * 口令哈希：PBKDF2-SHA256 / 100000 次迭代（docs/09 §9.1「密码哈希」，M0 简报 §6.2）。
 *
 * 存储格式（**带算法前缀**，可平滑升级）：
 *
 * ```
 * pbkdf2$sha256$100000$<saltBase64Url>$<derivedKeyBase64Url>
 * ```
 *
 * - `salt`：16 字节密码学随机，base64url 无 padding
 * - 派生密钥：32 字节，base64url 无 padding
 * - 全部经 WebCrypto（`crypto.subtle`），**不使用** `node:crypto`
 *
 * ⚠️ 文档未定义项：salt 长度、派生长度与 `pbkdf2$` 内部字段拼接（M0 简报 §8 第 7 项）。
 * 本文件即该定案：**16 字节 salt / 32 字节派生 / `$` 分隔 5 段**。
 */

import { base64UrlToBytes, bytesToBase64Url, constantTimeEqual, randomBytes } from "./encoding.js";

/** 存储格式的算法标识。 */
export const PASSWORD_ALGORITHM = "pbkdf2" as const;
/** 存储格式的摘要标识。 */
export const PASSWORD_DIGEST = "sha256" as const;
/** PBKDF2 迭代次数（**固定 100000**，docs/09 §9.1）。 */
export const PBKDF2_ITERATIONS = 100_000;
/** salt 字节长度。 */
export const PBKDF2_SALT_BYTES = 16;
/** 派生密钥字节长度。 */
export const PBKDF2_DERIVED_KEY_BYTES = 32;

/** 存储格式的严格正则（`pbkdf2$sha256$100000$<salt>$<key>`）。 */
export const PASSWORD_HASH_REGEX = /^pbkdf2\$sha256\$100000\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/u;

/** 解析后的口令哈希结构。 */
export interface ParsedPasswordHash {
  readonly algorithm: typeof PASSWORD_ALGORITHM;
  readonly digest: typeof PASSWORD_DIGEST;
  readonly iterations: number;
  readonly salt: Uint8Array;
  readonly derivedKey: Uint8Array;
}

async function deriveBits(
  password: string,
  salt: Uint8Array,
  iterations: number,
  lengthBytes: number,
): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    keyMaterial,
    lengthBytes * 8,
  );
  return new Uint8Array(bits);
}

/** 生成口令哈希串（每次调用 salt 随机，故同一口令两次结果不同）。 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(PBKDF2_SALT_BYTES);
  const derivedKey = await deriveBits(password, salt, PBKDF2_ITERATIONS, PBKDF2_DERIVED_KEY_BYTES);
  return [
    PASSWORD_ALGORITHM,
    PASSWORD_DIGEST,
    String(PBKDF2_ITERATIONS),
    bytesToBase64Url(salt),
    bytesToBase64Url(derivedKey),
  ].join("$");
}

/**
 * 解析存储串；任何结构/编码问题返回 `null`（**不抛**）。
 *
 * 只接受 `pbkdf2$sha256$<iterations>$<salt>$<key>` 形态，其余算法前缀一律拒绝。
 */
export function parsePasswordHash(stored: string): ParsedPasswordHash | null {
  const parts = stored.split("$");
  if (parts.length !== 5) return null;
  const [algorithm, digest, iterationsText, saltText, keyText] = parts;
  if (algorithm !== PASSWORD_ALGORITHM || digest !== PASSWORD_DIGEST) return null;
  if (saltText === undefined || keyText === undefined || iterationsText === undefined) return null;

  const iterations = Number(iterationsText);
  if (!Number.isInteger(iterations) || iterations <= 0) return null;

  const salt = base64UrlToBytes(saltText);
  const derivedKey = base64UrlToBytes(keyText);
  if (salt === null || derivedKey === null) return null;
  if (salt.length === 0 || derivedKey.length === 0) return null;

  return { algorithm, digest, iterations, salt, derivedKey };
}

/**
 * 校验口令。**常量时间**比较派生密钥；解析失败或格式不符返回 `false`（不抛）。
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parsePasswordHash(stored);
  if (parsed === null) return false;
  try {
    const candidate = await deriveBits(
      password,
      parsed.salt,
      parsed.iterations,
      parsed.derivedKey.length,
    );
    return constantTimeEqual(bytesToBase64Url(candidate), bytesToBase64Url(parsed.derivedKey));
  } catch {
    return false;
  }
}

/** 存储串是否为受支持的 PBKDF2 格式。 */
export function isPasswordHashFormat(stored: string): boolean {
  return parsePasswordHash(stored) !== null;
}
