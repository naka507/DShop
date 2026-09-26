/**
 * 口令哈希：算法分派表 + 登录惰性升级钩子（docs/09 §9.1「密码哈希」，docs/04 升级缝 S3）。
 *
 * 存储格式（**带算法前缀**，可平滑升级）：
 *
 * ```
 * <algorithm>$<digest>$<iterations>$<saltBase64Url>$<derivedKeyBase64Url>
 * ```
 *
 * 当前注册的算法为 `pbkdf2`（`pbkdf2$sha256$100000$<salt>$<key>`）：
 *
 * - `salt`：16 字节密码学随机，base64url 无 padding
 * - 派生密钥：32 字节，base64url 无 padding
 * - 全部经 WebCrypto（`crypto.subtle`），**不使用** `node:crypto`
 *
 * ## 升级缝 S3（docs/04）
 *
 * 本文件是口令算法的**唯一分派点**：新增算法只需在 `ALGORITHMS` 表中注册一项
 * （`PasswordAlgorithm` 接口），调用方零改动 —— 解析、验证、惰性升级全部走分派表。
 *
 * **升级目标是 argon2id**（抗 GPU/ASIC，参数内存硬化）。但 argon2id 在 Cloudflare
 * Workers 上需要 WASM 或付费 CPU 档位（免费档的 CPU 时间与可用内存不足以安全跑内存硬化），
 * 属 S3 升级项，本文件**只预留位置、不实现**。
 *
 * 惰性升级：登录时用 `verifyPasswordDetailed` / `verifyPassword` 校验，若存量哈希参数
 * 落后于当前推荐值，则 `VerifyResult.needsRehash` 为 `true`，调用方据此用
 * `hashPassword` 重新落库（或直接用 `upgradePasswordHash` 一步拿到新哈希）。
 *
 * ⚠️ 文档未定义项：salt 长度、派生长度与内部字段拼接（M0 简报 §8 第 7 项）。
 * 本文件即该定案：**16 字节 salt / 32 字节派生 / `$` 分隔 5 段**。
 */

import { base64UrlToBytes, bytesToBase64Url, constantTimeEqual, randomBytes } from "./encoding.js";

/** 存储格式的算法标识。 */
export const PASSWORD_ALGORITHM = "pbkdf2" as const;
/** 存储格式的摘要标识。 */
export const PASSWORD_DIGEST = "sha256" as const;
/** PBKDF2 迭代次数（**当前推荐值**，docs/09 §9.1）。低于此值的存量哈希需惰性升级。 */
export const PBKDF2_ITERATIONS = 100_000;
/** salt 字节长度。 */
export const PBKDF2_SALT_BYTES = 16;
/** 派生密钥字节长度。 */
export const PBKDF2_DERIVED_KEY_BYTES = 32;

/** 存储格式的严格正则（`pbkdf2$sha256$100000$<salt>$<key>`）。 */
export const PASSWORD_HASH_REGEX = /^pbkdf2\$sha256\$100000\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/u;

/** 解析后的口令哈希结构。 */
export interface ParsedPasswordHash {
  /** 前缀里的算法标识，如 `pbkdf2`。 */
  readonly algorithm: string;
  /** 摘要标识，如 `sha256`。 */
  readonly digest: string;
  readonly iterations: number;
  readonly salt: Uint8Array;
  readonly derivedKey: Uint8Array;
}

/** 校验结果：`ok` 为验证是否通过，`needsRehash` 表示存量哈希是否应升级。 */
export interface VerifyResult {
  readonly ok: boolean;
  /** 明文验证通过、但存量哈希的参数已落后 → 调用方应当用新参数重新哈希并落库。 */
  readonly needsRehash: boolean;
}

/** 各算法的实现签名。新增算法只需在此表注册，调用方零改动。 */
interface PasswordAlgorithm {
  /** 前缀里的算法标识，如 `pbkdf2`。 */
  readonly id: string;
  /** 该算法期望的摘要标识（可选；`pbkdf2` 为 `sha256`）。 */
  readonly digest?: string;
  /** 用给定参数派生密钥。 */
  hash(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array>;
  /** 该算法的参数是否已落后于当前推荐值（用于惰性升级判定）。 */
  needsRehash(iterations: number): boolean;
}

/** PBKDF2 派生（WebCrypto `crypto.subtle`，`SHA-256`）。 */
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

/** `pbkdf2` 算法实现（当前唯一注册项）。 */
const pbkdf2Algorithm: PasswordAlgorithm = {
  id: PASSWORD_ALGORITHM,
  digest: PASSWORD_DIGEST,
  hash(password, salt, iterations) {
    return deriveBits(password, salt, iterations, PBKDF2_DERIVED_KEY_BYTES);
  },
  needsRehash(iterations) {
    return iterations < PBKDF2_ITERATIONS;
  },
};

/**
 * 算法分派表：`id` → 实现。
 *
 * 新增算法（如 S3 的 `argon2id`）只需在下方 `new Map([...])` 中追加一项即可，
 * 解析 / 验证 / 惰性升级逻辑无需改动 —— 这是**单点注册**。
 */
const ALGORITHMS: ReadonlyMap<string, PasswordAlgorithm> = new Map([
  [pbkdf2Algorithm.id, pbkdf2Algorithm],
  // S3 升级项：`argon2id` 待注册（Workers 上需 WASM 或付费 CPU 档位，暂不实现）。
]);

/** 按存储格式拼装哈希串。 */
function formatHash(
  algorithm: string,
  digest: string,
  iterations: number,
  salt: Uint8Array,
  derivedKey: Uint8Array,
): string {
  return [
    algorithm,
    digest,
    String(iterations),
    bytesToBase64Url(salt),
    bytesToBase64Url(derivedKey),
  ].join("$");
}

/** 生成口令哈希串（每次调用 salt 随机，故同一口令两次结果不同）。 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(PBKDF2_SALT_BYTES);
  const derivedKey = await pbkdf2Algorithm.hash(password, salt, PBKDF2_ITERATIONS);
  return formatHash(PASSWORD_ALGORITHM, PASSWORD_DIGEST, PBKDF2_ITERATIONS, salt, derivedKey);
}

/**
 * 解析存储串；任何结构/编码问题返回 `null`（**不抛**）。
 *
 * 形态为 `<algorithm>$<digest>$<iterations>$<salt>$<key>`；算法标识必须在 `ALGORITHMS`
 * 分派表中注册，**未注册的算法前缀一律拒绝**（返回 `null`）。
 */
export function parsePasswordHash(stored: string): ParsedPasswordHash | null {
  const parts = stored.split("$");
  if (parts.length !== 5) return null;
  const [algorithm, digest, iterationsText, saltText, keyText] = parts;
  if (algorithm === undefined || digest === undefined) return null;

  const impl = ALGORITHMS.get(algorithm);
  if (impl === undefined) return null;
  if (impl.digest !== undefined && impl.digest !== digest) return null;

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
 * 校验口令并给出惰性升级信号。**常量时间**比较派生密钥；解析失败或格式不符返回
 * `{ ok: false, needsRehash: false }`（不抛）。
 *
 * - 验证通过且参数已落后 → `{ ok: true, needsRehash: true }`
 * - 验证通过且参数为当前推荐值 → `{ ok: true, needsRehash: false }`
 * - 验证失败 → `{ ok: false, needsRehash: false }`
 */
export async function verifyPasswordDetailed(
  password: string,
  stored: string,
): Promise<VerifyResult> {
  const parsed = parsePasswordHash(stored);
  if (parsed === null) return { ok: false, needsRehash: false };
  const impl = ALGORITHMS.get(parsed.algorithm);
  if (impl === undefined) return { ok: false, needsRehash: false };
  try {
    const candidate = await impl.hash(password, parsed.salt, parsed.iterations);
    const ok = constantTimeEqual(bytesToBase64Url(candidate), bytesToBase64Url(parsed.derivedKey));
    if (!ok) return { ok: false, needsRehash: false };
    return { ok: true, needsRehash: impl.needsRehash(parsed.iterations) };
  } catch {
    return { ok: false, needsRehash: false };
  }
}

/**
 * 校验口令，返回布尔（**兼容入口**，签名与历史版本一致，调用方无需改动）。
 *
 * 需要惰性升级信号时改用 `verifyPasswordDetailed`。
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  return (await verifyPasswordDetailed(password, stored)).ok;
}

/** `verifyPassword` 的显式别名（布尔语义，便于调用点自证）。 */
export async function verifyPasswordBoolean(password: string, stored: string): Promise<boolean> {
  return verifyPassword(password, stored);
}

/**
 * 惰性升级：验证通过且存量参数已落后时，用当前推荐参数重新哈希并返回新哈希串；
 * 无需升级（或验证失败）时返回 `null`（不抛）。
 */
export async function upgradePasswordHash(
  password: string,
  stored: string,
): Promise<string | null> {
  const result = await verifyPasswordDetailed(password, stored);
  if (!result.ok || !result.needsRehash) return null;
  return hashPassword(password);
}

/** 存储串是否为受支持格式（算法已注册且结构合法）。 */
export function isPasswordHashFormat(stored: string): boolean {
  return parsePasswordHash(stored) !== null;
}
