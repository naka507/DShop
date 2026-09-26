/**
 * WebCrypto（全局 `crypto.subtle`）薄封装。
 *
 * 运行环境：Cloudflare Workers。**禁止** `node:crypto` / `Buffer` / `process`。
 *
 * 注意：`@cloudflare/workers-types` 把 WebCrypto 声明为全局 `declare const crypto`
 * （不在 `typeof globalThis` 上），故统一用裸标识符 `crypto`。
 */

import { bytesToHex, utf8ToBytes } from "./encoding.js";

/** HMAC 支持的摘要算法。 */
export type HmacHash = "SHA-256" | "SHA-1";

type BytesLike = Uint8Array | string;

function toBytes(value: BytesLike): Uint8Array {
  return typeof value === "string" ? utf8ToBytes(value) : value;
}

/** `SHA-256(bytes)` → 32 字节。 */
export async function sha256Bytes(data: BytesLike): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", toBytes(data));
  return new Uint8Array(digest);
}

/** `SHA-256` 的 hex（小写）。 */
export async function sha256Hex(data: BytesLike): Promise<string> {
  return bytesToHex(await sha256Bytes(data));
}

/** 导入 HMAC 密钥。 */
export async function importHmacKey(
  keyMaterial: BytesLike,
  hash: HmacHash,
  usages: readonly string[] = ["sign"],
): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", toBytes(keyMaterial), { name: "HMAC", hash }, false, [
    ...usages,
  ]);
}

/** `HMAC(key, message)`（算法由 `hash` 指定）→ 原始字节。 */
export async function hmac(
  hash: HmacHash,
  keyMaterial: BytesLike,
  message: BytesLike,
): Promise<Uint8Array> {
  const key = await importHmacKey(keyMaterial, hash);
  const signature = await crypto.subtle.sign("HMAC", key, toBytes(message));
  return new Uint8Array(signature);
}

/** `HMAC-SHA256(key, message)` → 原始字节。 */
export async function hmacSha256(keyMaterial: BytesLike, message: BytesLike): Promise<Uint8Array> {
  return hmac("SHA-256", keyMaterial, message);
}

/** `HMAC-SHA256(key, message)` → hex（小写）。 */
export async function hmacSha256Hex(keyMaterial: BytesLike, message: BytesLike): Promise<string> {
  return bytesToHex(await hmacSha256(keyMaterial, message));
}

/** `HMAC-SHA1(key, message)` → 原始字节（TOTP 用）。 */
export async function hmacSha1(keyMaterial: BytesLike, message: BytesLike): Promise<Uint8Array> {
  return hmac("SHA-1", keyMaterial, message);
}
