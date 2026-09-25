import { describe, expect, it } from "vitest";

import {
  AGENT_ERROR_CODES,
  AGENT_ERROR_META,
  AgentEnvelopeSchema,
  httpStatusFor,
  messageFor,
  OK_MESSAGE,
} from "../src/errors.js";
import {
  AFTERSALE_NO_PATTERN,
  ID_TIMESTAMP_OFFSET_MINUTES,
  ORDER_NO_PATTERN,
  PAY_NO_PATTERN,
  REFUND_NO_PATTERN,
  SUB_ORDER_NO_PATTERN,
  ULID_LENGTH,
  formatAftersaleNo,
  formatOrderNo,
  formatPayNo,
  formatRefundNo,
  formatSubOrderNo,
  isUlid,
  newId,
  parseAftersaleNoDate,
  parseOrderNoTimestamp,
  subOrderIndex,
} from "../src/ids.js";

describe("错误码表（docs/07 §7.1，14 项含成功码）", () => {
  it("恰好 14 个错误码", () => {
    expect(Object.keys(AGENT_ERROR_CODES)).toHaveLength(14);
  });

  it("码值与文档逐字一致", () => {
    expect(AGENT_ERROR_CODES.OK).toBe(0);
    expect(AGENT_ERROR_CODES.INVALID_PARAM).toBe(40001);
    expect(AGENT_ERROR_CODES.UNSUPPORTED_CONTRACT_VERSION).toBe(40010);
    expect(AGENT_ERROR_CODES.TOKEN_MISSING_OR_INVALID).toBe(40101);
    expect(AGENT_ERROR_CODES.TOKEN_REVOKED).toBe(40102);
    expect(AGENT_ERROR_CODES.SCOPE_INSUFFICIENT).toBe(40301);
    expect(AGENT_ERROR_CODES.ORDER_NOT_FOUND).toBe(40401);
    expect(AGENT_ERROR_CODES.PRODUCT_NOT_FOUND).toBe(40402);
    expect(AGENT_ERROR_CODES.AFTERSALE_NOT_FOUND).toBe(40403);
    expect(AGENT_ERROR_CODES.POLICY_NOT_EFFECTIVE).toBe(40404);
    expect(AGENT_ERROR_CODES.METHOD_NOT_ALLOWED).toBe(40501);
    expect(AGENT_ERROR_CODES.IDEMPOTENCY_CONFLICT).toBe(40901);
    expect(AGENT_ERROR_CODES.RATE_LIMITED).toBe(42901);
    expect(AGENT_ERROR_CODES.INTERNAL_ERROR).toBe(50001);
  });

  it("每个码都有 HTTP 状态与文案", () => {
    for (const code of Object.values(AGENT_ERROR_CODES)) {
      expect(AGENT_ERROR_META[code]).toBeDefined();
      expect(typeof AGENT_ERROR_META[code].http).toBe("number");
      expect(AGENT_ERROR_META[code].message.length).toBeGreaterThan(0);
    }
  });

  it("httpStatusFor 映射（含 40010 与 40501 两个易错项）", () => {
    expect(httpStatusFor(AGENT_ERROR_CODES.OK)).toBe(200);
    expect(httpStatusFor(AGENT_ERROR_CODES.INVALID_PARAM)).toBe(400);
    expect(httpStatusFor(AGENT_ERROR_CODES.UNSUPPORTED_CONTRACT_VERSION)).toBe(400);
    expect(httpStatusFor(AGENT_ERROR_CODES.TOKEN_MISSING_OR_INVALID)).toBe(401);
    expect(httpStatusFor(AGENT_ERROR_CODES.TOKEN_REVOKED)).toBe(401);
    expect(httpStatusFor(AGENT_ERROR_CODES.SCOPE_INSUFFICIENT)).toBe(403);
    expect(httpStatusFor(AGENT_ERROR_CODES.ORDER_NOT_FOUND)).toBe(404);
    expect(httpStatusFor(AGENT_ERROR_CODES.METHOD_NOT_ALLOWED)).toBe(405);
    expect(httpStatusFor(AGENT_ERROR_CODES.IDEMPOTENCY_CONFLICT)).toBe(409);
    expect(httpStatusFor(AGENT_ERROR_CODES.RATE_LIMITED)).toBe(429);
    expect(httpStatusFor(AGENT_ERROR_CODES.INTERNAL_ERROR)).toBe(500);
  });

  it("未知码降级为 500 / 未知错误", () => {
    expect(httpStatusFor(99999)).toBe(500);
    expect(messageFor(99999)).toBe("未知错误");
  });

  it("成功 message 为 ok（对齐 PiEcho fixture）", () => {
    expect(OK_MESSAGE).toBe("ok");
  });

  it("AgentEnvelopeSchema 接受 {code,message,data} 且拒绝缺字段", () => {
    expect(
      AgentEnvelopeSchema.safeParse({ code: 0, message: "ok", data: { a: 1 } }).success,
    ).toBe(true);
    expect(
      AgentEnvelopeSchema.safeParse({ code: 40401, message: "订单不存在", data: null })
        .success,
    ).toBe(true);
    expect(AgentEnvelopeSchema.safeParse({ code: 0, message: "ok" }).success).toBe(false);
    // 未登记的码被拒绝
    expect(
      AgentEnvelopeSchema.safeParse({ code: 12345, message: "x", data: null }).success,
    ).toBe(false);
  });
});

describe("ULID", () => {
  it("newId 产出 26 位且字符集合法", () => {
    const id = newId();
    expect(id).toHaveLength(ULID_LENGTH);
    expect(isUlid(id)).toBe(true);
  });

  it("newId 单调递增（同毫秒内也不重复）", () => {
    const ids = Array.from({ length: 200 }, () => newId());
    expect(new Set(ids).size).toBe(200);
  });

  it("排除 I/L/O/U 四个易混字符", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(/[ILOU]/.test(newId())).toBe(false);
    }
  });
});

describe("单号规则（docs/05 §5.3 / 简报 §3.6）", () => {
  it("正则与文档一致", () => {
    expect(ORDER_NO_PATTERN.source).toBe("^DS\\d{17}$");
    expect(SUB_ORDER_NO_PATTERN.source).toBe("^DS\\d{17}-\\d{2}$");
    expect(AFTERSALE_NO_PATTERN.source).toBe("^AS\\d{11}$");
    expect(PAY_NO_PATTERN.source).toBe("^PAY\\d{17}$");
    expect(REFUND_NO_PATTERN.source).toBe("^RF\\d{17}$");
  });

  it("内嵌时间戳为 UTC+8", () => {
    expect(ID_TIMESTAMP_OFFSET_MINUTES).toBe(8 * 60);
  });

  it("formatOrderNo 用 UTC+8 墙上时间", () => {
    // 2026-09-20T06:30:00.000Z ⇔ UTC+8 的 2026-09-20 14:30:00
    const utc = new Date(Date.UTC(2026, 8, 20, 6, 30, 0));
    expect(formatOrderNo(utc, 123)).toBe("DS20260920143000123");
  });

  it("formatOrderNo 跨日边界（UTC 16:00 → UTC+8 次日 00:00）", () => {
    const utc = new Date(Date.UTC(2026, 8, 20, 16, 0, 0));
    expect(formatOrderNo(utc, 1)).toBe("DS20260921000000001");
  });

  it("formatOrderNo 序列越界抛错", () => {
    const utc = new Date(Date.UTC(2026, 8, 20, 6, 30, 0));
    expect(() => formatOrderNo(utc, 0)).toThrow(RangeError);
    expect(() => formatOrderNo(utc, 1000)).toThrow(RangeError);
    expect(() => formatOrderNo(utc, 1.5)).toThrow(RangeError);
  });

  it("formatSubOrderNo 追加 2 位序号", () => {
    expect(formatSubOrderNo("DS20260920143000123", 1)).toBe(
      "DS20260920143000123-01",
    );
    expect(formatSubOrderNo("DS20260920143000123", 12)).toBe(
      "DS20260920143000123-12",
    );
    expect(() => formatSubOrderNo("DS20260920143000123", 100)).toThrow(RangeError);
    expect(() => formatSubOrderNo("BAD", 1)).toThrow(RangeError);
  });

  it("formatAftersaleNo 只内嵌日期", () => {
    const utc = new Date(Date.UTC(2026, 8, 22, 1, 0, 0));
    expect(formatAftersaleNo(utc, 1)).toBe("AS20260922001");
  });

  it("formatPayNo / formatRefundNo 前缀正确", () => {
    const utc = new Date(Date.UTC(2026, 8, 20, 6, 30, 0));
    expect(formatPayNo(utc, 1)).toMatch(PAY_NO_PATTERN);
    expect(formatRefundNo(utc, 1)).toMatch(REFUND_NO_PATTERN);
  });
});

describe("单号反向解析（时区往返）", () => {
  it("parseOrderNoTimestamp 是 formatOrderNo 的反函数", () => {
    const utc = new Date(Date.UTC(2026, 8, 20, 6, 30, 0));
    const no = formatOrderNo(utc, 123);
    const back = parseOrderNoTimestamp(no);
    expect(back?.toISOString()).toBe("2026-09-20T06:30:00.000Z");
  });

  it("简报里的时区陷阱样例", () => {
    // DS20260920143000123 ⇔ 2026-09-20T06:30:00.000Z
    expect(parseOrderNoTimestamp("DS20260920143000123")?.toISOString()).toBe(
      "2026-09-20T06:30:00.000Z",
    );
  });

  it("非法单号返回 null（不抛异常）", () => {
    expect(parseOrderNoTimestamp("DS123")).toBeNull();
    expect(parseOrderNoTimestamp("ORD20260920143000123")).toBeNull();
    expect(parseOrderNoTimestamp("DS20261320143000123")).toBeNull();
  });

  it("parseAftersaleNoDate 返回当日 UTC+8 零点对应的 UTC 时刻", () => {
    expect(parseAftersaleNoDate("AS20260922001")?.toISOString()).toBe(
      "2026-09-21T16:00:00.000Z",
    );
    expect(parseAftersaleNoDate("AS20260922")).toBeNull();
  });

  it("subOrderIndex 解析子单序号", () => {
    expect(subOrderIndex("DS20260920143000123-01")).toBe(1);
    expect(subOrderIndex("DS20260920143000123-12")).toBe(12);
    expect(subOrderIndex("DS20260920143000123")).toBeNull();
    expect(subOrderIndex("BAD-01")).toBeNull();
  });
});
