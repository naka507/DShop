/**
 * 展示层格式化工具。
 *
 * **金额口径**：所有金额字段都是**整数、单位分**（`docs/05-数据模型.md` §5.3，
 * `packages/shared/src/contracts/common.ts` 的 `MoneySchema`）。
 * 页面**不得**直接渲染 `payAmount`，必须过 `formatMoney`，否则会显示成「19900 元」。
 */

/** 分 → 元字符串（保留两位小数）。`19900` → `"199.00"`。 */
export function formatMoney(amountInCents: number): string {
  const negative = amountInCents < 0;
  const abs = Math.abs(amountInCents);
  const yuan = Math.floor(abs / 100);
  const cents = abs % 100;
  const text = `${String(yuan)}.${String(cents).padStart(2, "0")}`;
  return negative ? `-${text}` : text;
}

/** 分 → 带币种符号的展示串。币种一期固定 `CNY`（`docs/05` §5.2）。 */
export function formatPrice(amountInCents: number, currency = "CNY"): string {
  const symbol = currency === "CNY" ? "¥" : "";
  return `${symbol}${formatMoney(amountInCents)}`;
}

/**
 * ISO-8601（**UTC**）→ 本地展示串。
 *
 * `docs/05` §5.3：时间字段一律 UTC ISO-8601；**单号内嵌的时间戳是 UTC+8**，
 * 两者不可混用（见 `packages/shared/src/ids.ts` 的时区陷阱注释）。
 */
export function formatDateTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === "") return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** 相对时间（「刚刚」「3 分钟前」），用于轮询状态的「上次更新」。 */
export function formatRelativeTime(timestampMs: number, nowMs: number = Date.now()): string {
  const diffSeconds = Math.max(0, Math.floor((nowMs - timestampMs) / 1000));
  if (diffSeconds < 10) return "刚刚";
  if (diffSeconds < 60) return `${String(diffSeconds)} 秒前`;
  const minutes = Math.floor(diffSeconds / 60);
  if (minutes < 60) return `${String(minutes)} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)} 小时前`;
  return `${String(Math.floor(hours / 24))} 天前`;
}

/** 规格对象 → `颜色: 曜石黑 / 版本: 降噪版`。 */
export function formatSpec(spec: Readonly<Record<string, string>>): string {
  const entries = Object.entries(spec);
  if (entries.length === 0) return "—";
  return entries.map(([key, value]) => `${key}: ${value}`).join(" / ");
}
