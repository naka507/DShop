/**
 * 仓储层共用的 JSON 解析与内容哈希工具（Agent 只读契约六端点）。
 *
 * 运行环境约束（Cloudflare Workers）：只用 WebCrypto / `TextEncoder` / `atob` / `btoa`；
 * **禁止** `node:crypto`、`Buffer`、`process`。哈希走 `@dshop/auth` 的 `sha256Hex`。
 */

import { sha256Hex } from "@dshop/auth";

/** 解析 JSON 对象；任何失败（null / 空串 / 非对象 / 语法错）返回 `{}`，绝不抛出。 */
export function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  const trimmed = raw.trim();
  if (trimmed.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 从对象取字符串字段；非字符串返回 `null`。 */
export function pickString(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === "string" ? value : null;
}

/**
 * 解析 SKU 的 `spec` JSON（`{"颜色":"曜石黑","版本":"降噪版"}`）。
 *
 * 只保留字符串值；键顺序保持原 JSON 的插入顺序（`specDimensions` 的取值顺序依赖它）。
 */
export function parseSkuSpec(raw: string | null | undefined): Record<string, string> {
  const obj = parseJsonObject(raw);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/** 解析 JSON 字符串数组（`tags`、`evidence_urls`）；失败返回 `[]`。 */
export function parseStringArray(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined) return [];
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

/**
 * 稳定 JSON 序列化：对象键**递归按字典序排序**后输出，数组保持原序。
 *
 * 目的：同一份内容任意次调用得到逐字节相同的字符串，从而 `contentHash` 稳定。
 */
export function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const body = keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
      .join(",");
    return `{${body}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "null" : encoded;
}

/**
 * 内容哈希：`sha256:` + 规范化 JSON 的 SHA-256 hex（小写）。
 *
 * 前缀 `sha256:` 与 `docs/07` §7.4 / §7.7 的响应示例一致（`"contentHash": "sha256:9f2c1a..."`）。
 */
export async function contentHashOf(value: unknown): Promise<string> {
  return `sha256:${await sha256Hex(stableStringify(value))}`;
}
