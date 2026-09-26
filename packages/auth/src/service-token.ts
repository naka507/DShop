/**
 * 服务令牌（Service Token）—— 本包最关键模块。
 *
 * 权威来源：`docs/07-Agent-API契约.md` §7.8.1（M0 简报 §4.3）。
 *
 * ```
 * dshop_svc_<24 位随机 base62>_<6 位校验位>
 * ```
 *
 * - 明文**仅创建时返回一次**；传输头 `X-Service-Token`（**非 Bearer**，**不允许**放 query string）
 * - 存储：`service_tokens.token_hash = HMAC-SHA256(AGENT_TOKEN_PEPPER, token)`
 * - `token_prefix` 存**前 16 位**（= `dshop_svc_` + 随机体前 6 位）便于识别与轮换
 * - 与用户体系**完全隔离**：服务令牌不是 JWT、不含 `aud`
 *
 * ⚠️ 文档未定义项：6 位校验位的具体算法（M0 简报 §8 未单列，属 §7.8.1 格式的补白）。
 * 本文件定案（**同步、可离线重算、与 HMAC 哈希职责分离**）：
 *
 * ```
 * body   = token 的第 2 段（24 位 base62 随机体）
 * digest = SHA-256(UTF-8(body))            // 前 4 字节按大端组成 uint32
 * checksum = base62Fixed( uint32 % 62^6 , 6 )   // BASE62_ALPHABET，定长 6 位
 * ```
 *
 * 校验位只用于**抄写/格式完整性**判定（防手抄错、防截断），**不承担安全职责**——
 * 安全由「不透明明文 + D1 中 HMAC 哈希比对」承担（docs/09 §9.1 的选择理由）。
 * `isServiceTokenFormat()` 会**真的重算校验位并比对**，而不是只测正则。
 */

import {
  BASE62_ALPHABET,
  base62FromNumber,
  bytesToHex,
  constantTimeEqual,
  randomBase62,
  sha256BytesSync,
  utf8ToBytes,
} from "./encoding.js";
import { hmacSha256 } from "./webcrypto.js";

export { BASE62_ALPHABET };

/** 令牌明文前缀（固定 10 字符）。 */
export const SERVICE_TOKEN_PREFIX = "dshop_svc_" as const;
/** 随机体长度（24 位 base62）。 */
export const SERVICE_TOKEN_BODY_LENGTH = 24;
/** 校验位长度（6 位 base62）。 */
export const SERVICE_TOKEN_CHECKSUM_LENGTH = 6;
/** `token_prefix` 取明文前 16 位。 */
export const SERVICE_TOKEN_PREFIX_LENGTH = 16;
/** 明文总长度：10 + 24 + 1 + 6 = 41。 */
export const SERVICE_TOKEN_TOTAL_LENGTH =
  SERVICE_TOKEN_PREFIX.length + SERVICE_TOKEN_BODY_LENGTH + 1 + SERVICE_TOKEN_CHECKSUM_LENGTH;
/** 校验位取值空间：`62^6`。 */
export const SERVICE_TOKEN_CHECKSUM_MODULUS = 62 ** SERVICE_TOKEN_CHECKSUM_LENGTH;

/**
 * 严格格式正则（**仅结构**；校验位真伪由 `isServiceTokenFormat()` 重算判定）。
 *
 * 之所以在这里不内联校验位算法，是为了让「正则」与「校验算法」两件事分别可读、可测。
 */
export const SERVICE_TOKEN_REGEX = new RegExp(
  `^dshop_svc_[0-9A-Za-z]{${SERVICE_TOKEN_BODY_LENGTH}}_[0-9A-Za-z]{${SERVICE_TOKEN_CHECKSUM_LENGTH}}$`,
  "u",
);

/** 默认有效期：**180 天**（07 §7.8.1）。 */
export const SERVICE_TOKEN_TTL_DAYS = 180;
/** 轮换宽限期：**7 天**（07 §7.8.1）。 */
export const SERVICE_TOKEN_ROTATION_GRACE_DAYS = 7;
/** 到期前告警窗口：**30 天**（07 §7.8.1）。 */
export const SERVICE_TOKEN_EXPIRY_WARNING_DAYS = 30;
/** 默认令牌级限流：**600 次/分钟**（07 §7.8.1）。 */
export const SERVICE_TOKEN_DEFAULT_RATE_LIMIT_PER_MIN = 600;

/** 待签串模板：`HMAC-SHA256(AGENT_SIGN_SECRET, timestamp + method + path + query)`（07 §7.8.1 可选加固）。 */
export const AGENT_SIGNATURE_MAX_SKEW_SECONDS = 300;

/* -------------------------------------------------------------------------- */
/* 校验位                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 计算 24 位随机体的 6 位校验位。
 *
 * 输入必须是**纯随机体**（不含 `dshop_svc_` 前缀、不含分隔下划线）。
 */
export function serviceTokenChecksum(body: string): string {
  const digest = sha256BytesSync(utf8ToBytes(body));
  const uint32 =
    (((digest[0] ?? 0) << 24) |
      ((digest[1] ?? 0) << 16) |
      ((digest[2] ?? 0) << 8) |
      (digest[3] ?? 0)) >>>
    0;
  return base62FromNumber(uint32 % SERVICE_TOKEN_CHECKSUM_MODULUS, SERVICE_TOKEN_CHECKSUM_LENGTH);
}

/* -------------------------------------------------------------------------- */
/* 签发 / 解析                                                                 */
/* -------------------------------------------------------------------------- */

/** 生成服务令牌**明文**（调用方随后用 `hashServiceToken` 落库哈希与 `serviceTokenPrefix` 落前缀）。 */
export function generateServiceToken(): string {
  const body = randomBase62(SERVICE_TOKEN_BODY_LENGTH);
  return `${SERVICE_TOKEN_PREFIX}${body}_${serviceTokenChecksum(body)}`;
}

/** `token_prefix` = 明文**前 16 位**（07 §7.8.1）。 */
export function serviceTokenPrefix(token: string): string {
  return token.slice(0, SERVICE_TOKEN_PREFIX_LENGTH);
}

/** 拆出随机体；结构不符返回 `null`。 */
export function serviceTokenBody(token: string): string | null {
  if (!SERVICE_TOKEN_REGEX.test(token)) return null;
  return token.slice(
    SERVICE_TOKEN_PREFIX.length,
    SERVICE_TOKEN_PREFIX.length + SERVICE_TOKEN_BODY_LENGTH,
  );
}

/**
 * 严格格式校验：**重算校验位并比对**（常量时间）。
 *
 * 结构不符、或校验位被篡改 → `false`。
 */
export function isServiceTokenFormat(token: string): boolean {
  const body = serviceTokenBody(token);
  if (body === null) return false;
  const actual = token.slice(SERVICE_TOKEN_PREFIX.length + SERVICE_TOKEN_BODY_LENGTH + 1);
  return constantTimeEqual(serviceTokenChecksum(body), actual);
}

/* -------------------------------------------------------------------------- */
/* 哈希 / 校验                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * `HMAC-SHA256(AGENT_TOKEN_PEPPER, token)` 的 **hex（小写）**——即 `service_tokens.token_hash`。
 *
 * `pepper` 由调用方从环境注入（`env.AGENT_TOKEN_PEPPER`），本包不读环境。
 */
export async function hashServiceToken(pepper: string, token: string): Promise<string> {
  const signature = await hmacSha256(pepper, token);
  return bytesToHex(signature);
}

/** 常量时间比较令牌哈希；`expectedHash` 大小写不敏感（hex）。 */
export async function verifyServiceToken(
  pepper: string,
  token: string,
  expectedHash: string,
): Promise<boolean> {
  const actual = await hashServiceToken(pepper, token);
  return constantTimeEqual(actual, expectedHash.toLowerCase());
}

/* -------------------------------------------------------------------------- */
/* 可选请求签名（07 §7.8.1；开关 `settings.agent_require_signature` 默认关闭）  */
/* -------------------------------------------------------------------------- */

/**
 * 计算请求签名（可选加固）。
 *
 * 待签串逐字照录 §7.8.1：`timestamp + method + path + query`（**直接拼接，无分隔符**）。
 *
 * @returns 小写 hex
 */
export async function signAgentRequest(
  signSecret: string,
  timestamp: string,
  method: string,
  path: string,
  query: string,
): Promise<string> {
  const signature = await hmacSha256(signSecret, `${timestamp}${method}${path}${query}`);
  return bytesToHex(signature);
}

/** 校验请求签名（含 `X-Timestamp` 偏离 `<= 300s` 检查）。 */
export async function verifyAgentRequestSignature(
  signSecret: string,
  timestamp: string,
  method: string,
  path: string,
  query: string,
  signature: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const timestampSeconds = Number(timestamp);
  if (!Number.isInteger(timestampSeconds)) return false;
  const skew = Math.abs(Math.floor(nowMs / 1000) - timestampSeconds);
  if (skew > AGENT_SIGNATURE_MAX_SKEW_SECONDS) return false;
  const expected = await signAgentRequest(signSecret, timestamp, method, path, query);
  return constantTimeEqual(expected, signature.toLowerCase());
}
