import { describe, expect, it } from "vitest";

import {
  evidenceCount,
  FORBIDDEN_FIELD_NAMES,
  isForbiddenField,
  maskAddress,
  maskAddressDetail,
  maskAddressSnapshot,
  maskName,
  maskPhone,
  regionPrefix,
  stripForbiddenFields,
} from "../src/mask.js";

describe("maskPhone", () => {
  it("11 位手机号保留前 3 后 4", () => {
    expect(maskPhone("13800138000")).toBe("138****8000");
    expect(maskPhone("13888888888")).toBe("138****8888");
  });
  it("剥离非数字字符后脱敏", () => {
    expect(maskPhone("+86 138-0013-8000")).toBe("138****8000");
  });

  it("null / undefined 返回 null", () => {
    expect(maskPhone(null)).toBeNull();
    expect(maskPhone(undefined)).toBeNull();
  });

  it("非 11 位走兜底规则，不抛异常", () => {
    expect(maskPhone("1234567")).toBe("12***67");
    expect(maskPhone("12")).toBe("**");
    expect(maskPhone("")).toBe("*");
  });
});

describe("maskName", () => {
  it("3 字姓名 → 张**", () => {
    expect(maskName("张小三")).toBe("张**");
  });

  it("2 字姓名 → 张*", () => {
    expect(maskName("张三")).toBe("张*");
  });

  it("1 字姓名保持不变", () => {
    expect(maskName("张")).toBe("张");
  });

  it("超过 3 字最多 2 个星号", () => {
    expect(maskName("欧阳锋大侠")).toBe("欧**");
  });

  it("空白/null 返回 null", () => {
    expect(maskName("   ")).toBeNull();
    expect(maskName(null)).toBeNull();
  });
});

describe("maskAddress", () => {
  it("保留省市区，详细地址整体遮蔽（07 §7.8.2 示例）", () => {
    expect(
      maskAddress({
        province: "浙江省",
        city: "杭州市",
        district: "西湖区",
        detail: "文三路 100 号 3 幢 501 室",
      }),
    ).toEqual({ region: "浙江省 杭州市 西湖区", detail: "***" });
  });

  it("缺省字段自动跳过", () => {
    expect(regionPrefix({ province: "浙江省", city: null, district: "西湖区" })).toBe(
      "浙江省 西湖区",
    );
  });

  it("详细地址为空也返回 ***", () => {
    expect(maskAddressDetail(null)).toBe("***");
    expect(maskAddressDetail("  ")).toBe("***");
  });
});

describe("maskAddressSnapshot", () => {
  it("解析 JSON 快照并脱敏", () => {
    const snapshot = JSON.stringify({
      province: "浙江省",
      city: "杭州市",
      district: "西湖区",
      detail: "文三路 100 号",
      receiverName: "张小三",
    });
    expect(maskAddressSnapshot(snapshot)).toEqual({
      region: "浙江省 杭州市 西湖区",
      detail: "***",
    });
  });

  it("脏数据不抛异常，返回全遮蔽", () => {
    expect(maskAddressSnapshot("not json")).toEqual({ region: "", detail: "***" });
    expect(maskAddressSnapshot(null)).toEqual({ region: "", detail: "***" });
    expect(maskAddressSnapshot("")).toEqual({ region: "", detail: "***" });
    expect(maskAddressSnapshot("[1,2]")).toEqual({ region: "", detail: "***" });
  });
});

describe("禁止下发字段", () => {
  it("识别 snake_case 与 camelCase 两种写法", () => {
    expect(isForbiddenField("password_hash")).toBe(true);
    expect(isForbiddenField("passwordHash")).toBe(true);
    expect(isForbiddenField("raw_callback")).toBe(true);
    expect(isForbiddenField("costPrice")).toBe(true);
    expect(isForbiddenField("totpSecret")).toBe(true);
    expect(isForbiddenField("evidenceUrls")).toBe(true);
    expect(isForbiddenField("orderNo")).toBe(false);
  });

  it("递归剔除，且不修改入参", () => {
    const input = {
      orderNo: "DS20260920143000123",
      password_hash: "pbkdf2$...",
      nested: { costPrice: 100, title: "极光 Pro" },
      list: [{ rawCallback: "{}", ok: 1 }],
    };
    const out = stripForbiddenFields(input);
    expect(out).toEqual({
      orderNo: "DS20260920143000123",
      nested: { title: "极光 Pro" },
      list: [{ ok: 1 }],
    });
    // 入参未被修改
    expect(input.password_hash).toBe("pbkdf2$...");
    expect(input.nested.costPrice).toBe(100);
  });

  it("原始值与 null 原样返回", () => {
    expect(stripForbiddenFields(null)).toBeNull();
    expect(stripForbiddenFields(42)).toBe(42);
    expect(stripForbiddenFields("x")).toBe("x");
  });

  it("FORBIDDEN_FIELD_NAMES 覆盖 07 §7.8.2 红线字段", () => {
    const required = [
      "password_hash",
      "openid",
      "raw_callback",
      "cost_price",
      "evidence_urls",
      "address_snapshot",
    ];
    for (const name of required) {
      expect(FORBIDDEN_FIELD_NAMES).toContain(name);
    }
  });
});

describe("evidenceCount", () => {
  it("只返回数量，不泄漏 URL", () => {
    expect(evidenceCount('["https://x/1.jpg","https://x/2.jpg"]')).toBe(2);
    expect(evidenceCount("[]")).toBe(0);
    expect(evidenceCount(null)).toBe(0);
    expect(evidenceCount("not json")).toBe(0);
    expect(evidenceCount('{"a":1}')).toBe(0);
  });
});
