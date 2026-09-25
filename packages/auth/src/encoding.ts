/**
 * 低层编码助手：base64url / base32 / base62 / hex + 常量时间比较 + 纯 JS SHA-256。
 *
 * 运行环境约束：Cloudflare Workers（workerd）。**只用** 全局 `crypto.getRandomValues`、
 * `TextEncoder` / `TextDecoder`、`atob` / `btoa`；不引入 `node:crypto`、`Buffer`、`process`。
 *
 * 注意：`@cloudflare/workers-types` 把 WebCrypto 声明为全局 `declare const crypto`（不在
 * `typeof globalThis` 上），因此本包统一使用裸标识符 `crypto`，**不要**写成 `globalThis.crypto`。
 *
 * 唯一例外是 `sha256BytesSync`（纯 JS 实现）：服务令牌校验位必须在**同步**函数
 * `isServiceTokenFormat()` 里重算，而 `crypto.subtle.digest` 只有异步形态。
 * 该校验位只用于「格式/抄写完整性」判定，不承担安全职责（安全由 HMAC 令牌哈希承担），
 * 因此纯 JS 实现是可接受的；它与 WebCrypto 的一致性由测试交叉验证。
 */

/** base62 字母表（**固定**，服务令牌随机体与校验位共用）。 */
export const BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** RFC 4648 base32 字母表（大写、无 padding）。 */
export const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export const BASE62_RADIX = 62;
export const BASE32_RADIX = 32;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8");
const HEX_ALPHABET = "0123456789abcdef";

/* -------------------------------------------------------------------------- */
/* UTF-8                                                                      */
/* -------------------------------------------------------------------------- */

export function utf8ToBytes(value: string): Uint8Array {
  return textEncoder.encode(value);
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

/* -------------------------------------------------------------------------- */
/* 随机                                                                       */
/* -------------------------------------------------------------------------- */

/** 密码学安全随机字节（`crypto.getRandomValues`）。 */
export function randomBytes(length: number): Uint8Array {
  if (!Number.isInteger(length) || length <= 0) {
    throw new RangeError(`randomBytes: length 必须为正整数，收到 ${String(length)}`);
  }
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

/**
 * 定长随机 base62 串（拒绝采样，避免取模偏差）。
 *
 * `256 % 62 = 8`，故丢弃 `>= 248` 的字节，其余 `byte % 62` 均匀落在 62 个字符上。
 */
export function randomBase62(length: number): string {
  if (!Number.isInteger(length) || length <= 0) {
    throw new RangeError(`randomBase62: length 必须为正整数，收到 ${String(length)}`);
  }
  const limit = 256 - (256 % BASE62_RADIX);
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(32)) {
      if (byte >= limit) continue;
      out += BASE62_ALPHABET.charAt(byte % BASE62_RADIX);
      if (out.length === length) break;
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* base64url（无 padding）                                                     */
/* -------------------------------------------------------------------------- */

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

/** 解析 base64url；非法输入返回 `null`（不抛）。 */
export function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) return null;
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padding = (4 - (normalized.length % 4)) % 4;
    const binary = atob(normalized + "=".repeat(padding));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* hex                                                                        */
/* -------------------------------------------------------------------------- */

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += HEX_ALPHABET.charAt(byte >>> 4);
    out += HEX_ALPHABET.charAt(byte & 0x0f);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* base32（RFC 4648，大写、无 padding）                                        */
/* -------------------------------------------------------------------------- */

export function bytesToBase32(bytes: Uint8Array): string {
  let bits = 0;
  let buffer = 0;
  let out = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET.charAt((buffer >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET.charAt((buffer << (5 - bits)) & 31);
  return out;
}

/** 解析 base32（大小写不敏感、容忍 padding 与空白）；非法输入返回 `null`。 */
export function base32ToBytes(value: string): Uint8Array | null {
  const cleaned = value.replace(/[\s=]/gu, "").toUpperCase();
  if (cleaned.length === 0 || !/^[A-Z2-7]+$/u.test(cleaned)) return null;
  let bits = 0;
  let buffer = 0;
  const out: number[] = [];
  for (const ch of cleaned) {
    const index = BASE32_ALPHABET.indexOf(ch);
    if (index < 0) return null;
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/* -------------------------------------------------------------------------- */
/* base62（定长数字编码）                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 把非负整数编码为**定长** base62 串（高位补 `0`，低位在右）。
 *
 * 用于服务令牌校验位：`uint32 % 62^6` 落在 `[0, 62^6)`，恰好 6 位定长。
 */
export function base62FromNumber(value: number, length: number): string {
  if (!Number.isInteger(length) || length <= 0) {
    throw new RangeError(`base62FromNumber: length 必须为正整数，收到 ${String(length)}`);
  }
  let rest = Math.floor(Math.abs(value));
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out = BASE62_ALPHABET.charAt(rest % BASE62_RADIX) + out;
    rest = Math.floor(rest / BASE62_RADIX);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* 常量时间比较                                                                */
/* -------------------------------------------------------------------------- */

/**
 * 常量时间字符串比较（UTF-8 逐字节异或累加）。
 *
 * 长度不同会立即返回 `false`（长度本身不是机密：比较对象是定长哈希/校验位）。
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = utf8ToBytes(a);
  const right = utf8ToBytes(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

/* -------------------------------------------------------------------------- */
/* SHA-256（纯 JS，同步）                                                      */
/* -------------------------------------------------------------------------- */

// 前 64 个素数立方根小数部分的前 32 位（FIPS 180-4）。
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value: number, shift: number): number {
  return ((value >>> shift) | (value << (32 - shift))) >>> 0;
}

/** 纯 JS SHA-256（FIPS 180-4），同步返回 32 字节摘要。 */
export function sha256BytesSync(input: Uint8Array): Uint8Array {
  const bitLength = input.length * 8;
  const withOne = input.length + 1;
  const paddedLength = withOne + ((56 - (withOne % 64)) + 64) % 64 + 8;
  const message = new Uint8Array(paddedLength);
  message.set(input, 0);
  message[input.length] = 0x80;

  const view = new DataView(message.buffer);
  const highBits = Math.floor(bitLength / 0x100000000);
  view.setUint32(paddedLength - 8, highBits);
  view.setUint32(paddedLength - 4, bitLength - highBits * 0x100000000);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15] ?? 0;
      const y = w[i - 2] ?? 0;
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + (SHA256_K[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const digest = new Uint8Array(32);
  const digestView = new DataView(digest.buffer);
  digestView.setUint32(0, h0);
  digestView.setUint32(4, h1);
  digestView.setUint32(8, h2);
  digestView.setUint32(12, h3);
  digestView.setUint32(16, h4);
  digestView.setUint32(20, h5);
  digestView.setUint32(24, h6);
  digestView.setUint32(28, h7);
  return digest;
}

/** 纯 JS SHA-256 hex（小写，同步）。 */
export function sha256HexSync(input: Uint8Array | string): string {
  return bytesToHex(sha256BytesSync(typeof input === "string" ? utf8ToBytes(input) : input));
}
