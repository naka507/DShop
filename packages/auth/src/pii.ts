/**
 * PII（个人身份信息）处理：手机号规范化 / 检索哈希 / 可逆加密。
 *
 * 权威来源：
 * - M0 简报 §7.7 —— `users.phone` **唯一、加密存储**；`/orders?phone=` 走「服务端规范化后 HMAC 比对」
 * - 07 §7.8.2 —— 手机号**绝不明文下发**（脱敏由 `packages/services/mask.ts` 负责）
 *
 * ⚠️ 文档未定义项：`users.phone` 的加密算法与密钥派生方式。
 * 本文件定案：
 *
 * | 用途 | 方案 |
 * | --- | --- |
 * | 规范化 | 去空白与 `-`，剥离 `+86` / `86` 国家码前缀，须为 11 位 `1` 开头 |
 * | 检索哈希 | `HMAC-SHA256(PHONE_HASH_PEPPER, 规范化11位)` hex（**不可逆**，用于 `/orders?phone=` 比对） |
 * | 可逆加密 | AES-256-GCM，密钥 = `SHA-256(keyMaterial)`（32 字节），IV 12 字节随机，密文含 128 位 tag |
 * | 密文封装 | `v1.<ivBase64Url>.<cipherBase64Url>`（三段点分，首段为版本位，便于轮换） |
 */

import {
  base64UrlToBytes,
  bytesToBase64Url,
  bytesToHex,
  bytesToUtf8,
  randomBytes,
  utf8ToBytes,
} from "./encoding.js";
import { hmacSha256, sha256Bytes } from "./webcrypto.js";

/** PII 密文封装版本。 */
export const PII_ENVELOPE_VERSION = "v1" as const;
/** 密文封装分隔符。 */
export const PII_ENVELOPE_SEPARATOR = "." as const;
/** AES-GCM IV 字节长度（NIST SP 800-38D 推荐 96 bit）。 */
export const PII_AES_GCM_IV_BYTES = 12;
/** AES-GCM 认证标签位长（WebCrypto 默认，附在密文尾部）。 */
export const PII_AES_GCM_TAG_LENGTH_BITS = 128;
/** 派生 AES 密钥的字节长度。 */
export const PII_AES_KEY_BYTES = 32;
/** 手机号正则：**11 位、`1` 开头**（M0 简报 §7.7 的判据，不做号段白名单）。 */
export const PHONE_REGEX = /^1\d{10}$/u;

/* -------------------------------------------------------------------------- */
/* 手机号                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 规范化手机号。
 *
 * 支持 `+86 138-0013-8000` / `8613800138000` / `138 0013 8000` 等写法；
 * 结果必须为 11 位 `1` 开头数字，否则返回 `null`（**不抛**）。
 */
export function normalizePhone(input: string): string | null {
  if (typeof input !== "string") return null;
  let value = input.replace(/[\s\-()（）]/gu, "");
  if (value === "") return null;

  if (value.startsWith("+")) value = value.slice(1);
  if (value.startsWith("0086")) value = value.slice(4);
  else if (value.startsWith("86") && value.length > 11) value = value.slice(2);

  if (!/^\d+$/u.test(value)) return null;
  if (!PHONE_REGEX.test(value)) return null;
  return value;
}

/**
 * 手机号检索哈希：`HMAC-SHA256(pepper, 规范化11位)` 的 **hex（小写）**。
 *
 * 输入先经 `normalizePhone`；非法手机号抛 `TypeError`（调用方应先用 `normalizePhone` 判空）。
 */
export async function hashPhone(pepper: string, phone: string): Promise<string> {
  const normalized = normalizePhone(phone);
  if (normalized === null) {
    throw new TypeError(`hashPhone: 非法手机号 ${phone}`);
  }
  return bytesToHex(await hmacSha256(pepper, normalized));
}

/** 常量时间比较手机号哈希（`expectedHash` 大小写不敏感）。 */
export async function verifyPhoneHash(
  pepper: string,
  phone: string,
  expectedHash: string,
): Promise<boolean> {
  const normalized = normalizePhone(phone);
  if (normalized === null) return false;
  const actual = await hashPhone(pepper, normalized);
  const expected = expectedHash.toLowerCase();
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i += 1) {
    diff |= (actual.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/* -------------------------------------------------------------------------- */
/* 可逆加密（AES-256-GCM）                                                     */
/* -------------------------------------------------------------------------- */

async function importAesKey(keyMaterial: string): Promise<CryptoKey> {
  const raw = await sha256Bytes(utf8ToBytes(keyMaterial));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * 加密 PII 明文。
 *
 * @param keyMaterial 密钥材料（如 `env.PII_ENC_KEY`）；经 SHA-256 派生为 32 字节 AES 密钥
 * @param plaintext 明文（UTF-8）
 * @returns `v1.<ivBase64Url>.<cipherBase64Url>`
 */
export async function encryptPii(keyMaterial: string, plaintext: string): Promise<string> {
  const key = await importAesKey(keyMaterial);
  const iv = randomBytes(PII_AES_GCM_IV_BYTES);
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: PII_AES_GCM_TAG_LENGTH_BITS },
    key,
    utf8ToBytes(plaintext),
  );
  return [
    PII_ENVELOPE_VERSION,
    bytesToBase64Url(iv),
    bytesToBase64Url(new Uint8Array(cipher)),
  ].join(PII_ENVELOPE_SEPARATOR);
}

/**
 * 解密 PII 密文。
 *
 * **任何失败（版本不符 / 结构错 / IV 非法 / 认证标签校验失败 / 密钥错误）返回 `null`，不抛**。
 */
export async function decryptPii(keyMaterial: string, payload: string): Promise<string | null> {
  const parts = payload.split(PII_ENVELOPE_SEPARATOR);
  if (parts.length !== 3) return null;
  const [version, ivText, cipherText] = parts;
  if (version !== PII_ENVELOPE_VERSION) return null;
  if (ivText === undefined || cipherText === undefined) return null;

  const iv = base64UrlToBytes(ivText);
  const cipher = base64UrlToBytes(cipherText);
  if (iv === null || cipher === null) return null;
  if (iv.length !== PII_AES_GCM_IV_BYTES) return null;
  if (cipher.length < PII_AES_GCM_TAG_LENGTH_BITS / 8) return null;

  try {
    const key = await importAesKey(keyMaterial);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, tagLength: PII_AES_GCM_TAG_LENGTH_BITS },
      key,
      cipher,
    );
    return bytesToUtf8(new Uint8Array(plain));
  } catch {
    return null;
  }
}

/** 密文是否符合 `v1.<iv>.<cipher>` 封装（**不**做解密，仅结构判定）。 */
export function isPiiEnvelope(payload: string): boolean {
  const parts = payload.split(PII_ENVELOPE_SEPARATOR);
  if (parts.length !== 3) return false;
  if (parts[0] !== PII_ENVELOPE_VERSION) return false;
  return base64UrlToBytes(parts[1] ?? "") !== null && base64UrlToBytes(parts[2] ?? "") !== null;
}
