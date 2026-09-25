/**
 * Agent 载荷脱敏器（`docs/07` §7.8.2）。
 *
 * 契约中心 `packages/shared/src/contracts/common.ts` 已用 Zod `.strip()` 白名单
 * 定义了下发字段；本模块负责**把库内原始行转换为契约载荷**，并在转换过程中
 * 执行字段级脱敏。任何未在契约中声明的字段都不会被带出——白名单在契约层，
 * 本层只做「取值 + 脱敏」，绝不 `...spread` 原始行。
 *
 * 硬性红线（07 §7.8.2）：
 * - 手机号 → `138****8888`
 * - 姓名   → `张**`（保留首字，其余替换为 `*`，最长 2 个 `*`）
 * - 地址   → `浙江省 杭州市 西湖区 ***`（省市区保留，详细地址整体遮蔽）
 * - 凭证 URL、`password_hash`、`openid`、`raw_callback`、`cost_price` 等**绝不下发**
 */

/** 手机号脱敏：保留前 3 位与后 4 位，中间 4 位替换为 `*`。 */
export function maskPhone(phone: string | null | undefined): string | null {
  if (phone === null || phone === undefined) return null;
  let digits = phone.replace(/\D/g, "");
  // 剥离国际区号：`+86 138-0013-8000` → `8613800138000` → `13800138000`
  if (digits.length === 13 && digits.startsWith("86")) {
    digits = digits.slice(2);
  }
  if (digits.length === 11) {
    return `${digits.slice(0, 3)}****${digits.slice(7)}`;
  }
  // 非 11 位：兜底保留首尾各 2 位，其余遮蔽；长度不足 4 位则整体遮蔽。
  if (digits.length < 4) return "*".repeat(Math.max(digits.length, 1));
  return `${digits.slice(0, 2)}${"*".repeat(digits.length - 4)}${digits.slice(-2)}`;
}

/**
 * 姓名脱敏：保留首字，其余以 `*` 遮蔽（最多 2 个 `*`，与 07 §7.8.2 示例 `张**` 一致）。
 *
 * - 1 字姓名：`张` → `张`
 * - 2 字姓名：`张三` → `张*`
 * - 3 字及以上：`张小三` → `张**`
 */
export function maskName(name: string | null | undefined): string | null {
  if (name === null || name === undefined) return null;
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  const chars = Array.from(trimmed);
  const first = chars[0] ?? "";
  const stars = Math.min(Math.max(chars.length - 1, 0), 2);
  return `${first}${"*".repeat(stars)}`;
}

/**
 * 详细地址脱敏：保留省/市/区，详细地址整体替换为 `***`。
 *
 * 07 §7.8.2 示例：`浙江省 杭州市 西湖区 ***`
 */
export function maskAddressDetail(detail: string | null | undefined): string {
  if (detail === null || detail === undefined) return "***";
  const trimmed = detail.trim();
  if (trimmed.length === 0) return "***";
  return "***";
}

/** 省市区前缀拼接：`浙江省 杭州市 西湖区`（缺省字段自动跳过）。 */
export function regionPrefix(parts: {
  province?: string | null;
  city?: string | null;
  district?: string | null;
}): string {
  return [parts.province, parts.city, parts.district]
    .map((p) => (p ?? "").trim())
    .filter((p) => p.length > 0)
    .join(" ");
}

/**
 * 完整收货地址脱敏（供 `ReceiverSchema` 的 `region`/`detail` 使用）。
 *
 * 返回 `{ region, detail }`：`region` 保留省市区，`detail` 恒为 `***`。
 */
export function maskAddress(input: {
  province?: string | null;
  city?: string | null;
  district?: string | null;
  detail?: string | null;
}): { region: string; detail: string } {
  return {
    region: regionPrefix(input),
    detail: maskAddressDetail(input.detail),
  };
}

/**
 * 地址快照 JSON 的脱敏解析。
 *
 * `orders.address_snapshot` 是下单瞬间固化的 JSON 原文，**绝不下发原文**。
 * 解析失败时返回全遮蔽结果，绝不抛出（避免因历史脏数据导致端点 500）。
 */
export function maskAddressSnapshot(snapshot: string | null | undefined): {
  region: string;
  detail: string;
} {
  if (snapshot === null || snapshot === undefined || snapshot.trim().length === 0) {
    return { region: "", detail: "***" };
  }
  try {
    const parsed: unknown = JSON.parse(snapshot);
    if (typeof parsed !== "object" || parsed === null) {
      return { region: "", detail: "***" };
    }
    const obj = parsed as Record<string, unknown>;
    const pick = (key: string): string | null => {
      const v = obj[key];
      return typeof v === "string" ? v : null;
    };
    return maskAddress({
      province: pick("province"),
      city: pick("city"),
      district: pick("district"),
      detail: pick("detail"),
    });
  } catch {
    return { region: "", detail: "***" };
  }
}

/**
 * 兜底递归脱敏：从任意对象中剔除**绝对禁止下发**的敏感键。
 *
 * 契约层白名单已保证正常路径不会泄漏；本函数是防御性第二道闸门，
 * 用于任何「先组装、后校验」的中间对象。键名匹配不区分大小写，
 * 且对 `snake_case` / `camelCase` 同时生效。
 */
export const FORBIDDEN_FIELD_NAMES: readonly string[] = [
  "password_hash",
  "passwordhash",
  "password",
  "openid",
  "unionid",
  "wechat_openid",
  "wechat_unionid",
  "raw_callback",
  "rawcallback",
  "cost_price",
  "costprice",
  "token_hash",
  "tokenhash",
  "totp_secret",
  "totpsecret",
  "phone_hash",
  "phonehash",
  "evidence_urls",
  "evidenceurls",
  "address_snapshot",
  "addresssnapshot",
  "settlement_account",
  "settlementaccount",
];

function normalizeKey(key: string): string {
  return key.replace(/[_\-\s]/g, "").toLowerCase();
}

const FORBIDDEN_SET: ReadonlySet<string> = new Set(
  FORBIDDEN_FIELD_NAMES.map((k) => normalizeKey(k)),
);

/** 该字段名是否属于禁止下发集合。 */
export function isForbiddenField(key: string): boolean {
  return FORBIDDEN_SET.has(normalizeKey(key));
}

/**
 * 递归剔除禁止下发的字段。返回**新对象**，不修改入参。
 *
 * 数组逐项处理；`null`/`undefined`/原始值原样返回。
 */
export function stripForbiddenFields<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => stripForbiddenFields(item)) as unknown as T;
  }
  if (typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (isForbiddenField(key)) continue;
    out[key] = stripForbiddenFields(v);
  }
  return out as unknown as T;
}

/** 凭证 URL 列表 → 仅数量（07 §7.8.2：`evidenceCount`）。 */
export function evidenceCount(evidenceUrlsJson: string | null | undefined): number {
  if (evidenceUrlsJson === null || evidenceUrlsJson === undefined) return 0;
  const trimmed = evidenceUrlsJson.trim();
  if (trimmed.length === 0) return 0;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.length;
    return 0;
  } catch {
    return 0;
  }
}
