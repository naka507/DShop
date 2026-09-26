/**
 * 展示格式化工具。
 *
 * 口径来自 `docs/05-数据模型.md` §5.3（金额与时间口径）：
 * - **金额：整数，单位「分」**（`MoneySchema`），展示时除 100
 * - **时间：ISO-8601 字符串，UTC**，展示时按浏览器本地时区渲染
 */

import dayjs from "dayjs";

/**
 * 分 → 人民币展示串。
 *
 * 例：`12345` → `"¥123.45"`。
 */
export function formatMoney(cents: number, currency = "CNY"): string {
  const symbol = currency === "CNY" ? "¥" : `${currency} `;
  const yuan = cents / 100;
  return `${symbol}${yuan.toFixed(2)}`;
}

/** ISO-8601（UTC）→ 本地时间展示；`null` / 非法值显示 `—`。 */
export function formatDateTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso.length === 0) return "—";
  const parsed = dayjs(iso);
  return parsed.isValid() ? parsed.format("YYYY-MM-DD HH:mm:ss") : "—";
}

/** ISO-8601（UTC）→ 本地日期展示。 */
export function formatDate(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso.length === 0) return "—";
  const parsed = dayjs(iso);
  return parsed.isValid() ? parsed.format("YYYY-MM-DD") : "—";
}

/** 相对到期时间（如「剩余 172 天」）；已过期返回「已过期」。 */
export function formatExpiry(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso.length === 0) return "—";
  const target = dayjs(iso);
  if (!target.isValid()) return "—";
  const days = target.diff(dayjs(), "day");
  if (days < 0) return "已过期";
  if (days === 0) return "今日到期";
  return `剩余 ${String(days)} 天`;
}

/**
 * 校验主单号 `^DS\d{17}$`。
 *
 * ⚠️ 该正则是**对外契约**（`packages/shared/src/ids.ts` 的 `ORDER_NO_PATTERN`），
 * 前端只用于表单前置校验，**权威校验在后端**。
 */
export const ORDER_NO_PATTERN = /^DS\d{17}$/;

/** 校验子单号 `^DS\d{17}-\d{2}$`。 */
export const SUB_ORDER_NO_PATTERN = /^DS\d{17}-\d{2}$/;

/** 校验售后单号 `^AS\d{11}$`（对外契约，不得放宽）。 */
export const AFTERSALE_NO_PATTERN = /^AS\d{11}$/;

/** 订单号是否合法。 */
export function isValidOrderNo(value: string): boolean {
  return ORDER_NO_PATTERN.test(value);
}

/** 售后单号是否合法。 */
export function isValidAftersaleNo(value: string): boolean {
  return AFTERSALE_NO_PATTERN.test(value);
}
