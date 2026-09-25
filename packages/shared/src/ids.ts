/**
 * ID 与单号规则（契约中心，零业务逻辑）。
 *
 * 权威来源：`docs/05-数据模型.md` §5.3⑤「单号格式（定案）」。
 *
 * ⚠️ **时区陷阱**：单号内嵌的时间戳是 **Asia/Shanghai（UTC+8）**，
 * 而所有时间字段（`createdAt` 等）是 **UTC ISO-8601**。
 * 例：`DS20260920143000123` ⇔ `createdAt = 2026-09-20T06:30:00.000Z`。
 * 生成单号必须先转 UTC+8 再格式化，否则会差 8 小时。
 */

import { ulid } from "ulid";
import { z } from "zod";

/** 单号内嵌时间戳使用的时区（05 §5.3⑤ 原文：Asia/Shanghai，UTC+8）。 */
export const ID_TIMESTAMP_OFFSET_MINUTES = 8 * 60;

/* -------------------------------------------------------------------------- */
/* 主键：ULID                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 主键统一为 **ULID 字符串（26 位，时间有序）**（05 §5.3⑤）。
 *
 * 文档示例：`01J9Z8K2M4N5P6Q7R8S9T0V1W2`。
 */
export const ULID_LENGTH = 26;

export const UlidSchema = z
  .string()
  .length(ULID_LENGTH, `ULID 必须为 ${ULID_LENGTH} 位`)
  .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "ULID 字符集不合法（Crocksford Base32，排除 I/L/O/U）");

/** 生成 ULID（时间有序，可用于主键）。 */
export function newId(): string {
  return ulid();
}

/** 校验字符串是否为合法 ULID。 */
export function isUlid(value: string): boolean {
  return UlidSchema.safeParse(value).success;
}

/* -------------------------------------------------------------------------- */
/* 单号正则（05 §5.3⑤ 逐字照录）                                               */
/* -------------------------------------------------------------------------- */

/** 主单号：`DS` + 17 位数字（总长 19）。 */
export const ORDER_NO_PATTERN = /^DS\d{17}$/;
/** 子单号：主单号 + `-` + 2 位序号。 */
export const SUB_ORDER_NO_PATTERN = /^DS\d{17}-\d{2}$/;
/** 售后单号：`AS` + 11 位数字（总长 13）。 */
export const AFTERSALE_NO_PATTERN = /^AS\d{11}$/;
/** 支付单号：`PAY` + 17 位数字。 */
export const PAY_NO_PATTERN = /^PAY\d{17}$/;
/** 退款单号：`RF` + 17 位数字。 */
export const REFUND_NO_PATTERN = /^RF\d{17}$/;

export const OrderNoSchema = z.string().regex(ORDER_NO_PATTERN, "订单号格式须为 ^DS\\d{17}$");
export const SubOrderNoSchema = z
  .string()
  .regex(SUB_ORDER_NO_PATTERN, "子单号格式须为 ^DS\\d{17}-\\d{2}$");
export const AftersaleNoSchema = z
  .string()
  .regex(AFTERSALE_NO_PATTERN, "售后单号格式须为 ^AS\\d{11}$");
export const PayNoSchema = z.string().regex(PAY_NO_PATTERN, "支付单号格式须为 ^PAY\\d{17}$");
export const RefundNoSchema = z.string().regex(REFUND_NO_PATTERN, "退款单号格式须为 ^RF\\d{17}$");

/* -------------------------------------------------------------------------- */
/* 单号生成                                                                    */
/* -------------------------------------------------------------------------- */

/** 序号格式化位数：主单 3 位当秒序列、售后 3 位当日序列。 */
const SEQ_WIDTH = 3;
/** 子单序号宽度：2 位。 */
const SUB_SEQ_WIDTH = 2;

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * 取「单号时间戳」的各分量（**UTC+8**）。
 *
 * 实现方式：把 UTC 时刻加上 8 小时偏移后用 UTC getter 读取，
 * 得到的就是 UTC+8 的墙上时间——不依赖运行环境的本地时区。
 */
function shiftedParts(date: Date): {
  yyyy: string;
  mm: string;
  dd: string;
  hh: string;
  mi: string;
  ss: string;
} {
  const shifted = new Date(date.getTime() + ID_TIMESTAMP_OFFSET_MINUTES * 60_000);
  return {
    yyyy: pad(shifted.getUTCFullYear(), 4),
    mm: pad(shifted.getUTCMonth() + 1, 2),
    dd: pad(shifted.getUTCDate(), 2),
    hh: pad(shifted.getUTCHours(), 2),
    mi: pad(shifted.getUTCMinutes(), 2),
    ss: pad(shifted.getUTCSeconds(), 2),
  };
}

/**
 * 生成主单号：`DS` + `YYYYMMDDHHmmss`(UTC+8) + 3 位当秒序列。
 *
 * @param date 生成时刻（UTC）。
 * @param seq  当秒内的序列号，`1`–`999`（调用方负责去重自增）。
 */
export function formatOrderNo(date: Date, seq: number): string {
  if (!Number.isInteger(seq) || seq < 1 || seq > 999) {
    throw new RangeError(`订单号当秒序列须为 1–999 的整数，收到 ${seq}`);
  }
  const p = shiftedParts(date);
  return `DS${p.yyyy}${p.mm}${p.dd}${p.hh}${p.mi}${p.ss}${pad(seq, SEQ_WIDTH)}`;
}

/** 生成子单号：主单号 + `-` + 2 位序号（从 `01` 起）。 */
export function formatSubOrderNo(orderNo: string, index: number): string {
  if (!ORDER_NO_PATTERN.test(orderNo)) {
    throw new RangeError(`主单号格式非法：${orderNo}`);
  }
  if (!Number.isInteger(index) || index < 1 || index > 99) {
    throw new RangeError(`子单序号须为 1–99 的整数，收到 ${index}`);
  }
  return `${orderNo}-${pad(index, SUB_SEQ_WIDTH)}`;
}

/**
 * 生成售后单号：`AS` + `YYYYMMDD`(UTC+8) + 3 位当日序列。
 *
 * @param date 生成时刻（UTC）。
 * @param seq  当日的序列号，`1`–`999`。
 */
export function formatAftersaleNo(date: Date, seq: number): string {
  if (!Number.isInteger(seq) || seq < 1 || seq > 999) {
    throw new RangeError(`售后单号当日序列须为 1–999 的整数，收到 ${seq}`);
  }
  const p = shiftedParts(date);
  return `AS${p.yyyy}${p.mm}${p.dd}${pad(seq, SEQ_WIDTH)}`;
}

/** 生成支付单号：`PAY` + 17 位（同主单号规则）。 */
export function formatPayNo(date: Date, seq: number): string {
  if (!Number.isInteger(seq) || seq < 1 || seq > 999) {
    throw new RangeError(`支付单号当秒序列须为 1–999 的整数，收到 ${seq}`);
  }
  const p = shiftedParts(date);
  return `PAY${p.yyyy}${p.mm}${p.dd}${p.hh}${p.mi}${p.ss}${pad(seq, SEQ_WIDTH)}`;
}

/** 生成退款单号：`RF` + 17 位（同主单号规则）。 */
export function formatRefundNo(date: Date, seq: number): string {
  if (!Number.isInteger(seq) || seq < 1 || seq > 999) {
    throw new RangeError(`退款单号当秒序列须为 1–999 的整数，收到 ${seq}`);
  }
  const p = shiftedParts(date);
  return `RF${p.yyyy}${p.mm}${p.dd}${p.hh}${p.mi}${p.ss}${pad(seq, SEQ_WIDTH)}`;
}

/**
 * 单号内嵌时间戳 → UTC 时刻（生成方向的反函数，用于测试与排查）。
 *
 * `DS20260920143000123` → `2026-09-20T06:30:00.000Z`。
 */
export function parseOrderNoTimestamp(orderNo: string): Date | null {
  if (!ORDER_NO_PATTERN.test(orderNo)) return null;
  return parseShiftedTimestamp(orderNo.slice(2, 16));
}

/** 售后单号内嵌日期 → 当日 `00:00:00`（UTC+8）对应的 UTC 时刻。 */
export function parseAftersaleNoDate(aftersaleNo: string): Date | null {
  if (!AFTERSALE_NO_PATTERN.test(aftersaleNo)) return null;
  return parseShiftedTimestamp(`${aftersaleNo.slice(2, 10)}000000`);
}

/** 解析 `YYYYMMDDHHmmss`（UTC+8 墙上时间）为 UTC `Date`。 */
function parseShiftedTimestamp(wall: string): Date | null {
  if (!/^\d{14}$/.test(wall)) return null;
  const year = Number(wall.slice(0, 4));
  const month = Number(wall.slice(4, 6));
  const day = Number(wall.slice(6, 8));
  const hour = Number(wall.slice(8, 10));
  const minute = Number(wall.slice(10, 12));
  const second = Number(wall.slice(12, 14));
  const wallMs = Date.UTC(year, month - 1, day, hour, minute, second);
  if (Number.isNaN(wallMs)) return null;
  // 反向校验：非法日期（如 2 月 30 日）会被 Date.UTC 归一化，需检出。
  const check = new Date(wallMs);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute ||
    check.getUTCSeconds() !== second
  ) {
    return null;
  }
  return new Date(wallMs - ID_TIMESTAMP_OFFSET_MINUTES * 60_000);
}

/** 从主单号取 2 位子单序号（`-01` → `1`）。 */
export function subOrderIndex(subOrderNo: string): number | null {
  if (!SUB_ORDER_NO_PATTERN.test(subOrderNo)) return null;
  return Number(subOrderNo.slice(-2));
}
