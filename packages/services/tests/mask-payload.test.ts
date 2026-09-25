/**
 * `maskAgentPayload()` 单一出口脱敏器测试（`docs/07` §7.8.2，M0 ★ 必交付项）。
 *
 * 覆盖：
 * (a) 白名单外字段被丢弃（顶层）
 * (b) 嵌套对象 / 数组内的未知字段也被丢弃
 * (c) schema 校验失败时**抛错而非原样返回**
 * (d) 黑名单字段即使被塞进 schema 定义，也被二次剔除
 */

import { z } from "zod";
import { describe, expect, it } from "vitest";

import { AgentPayloadMaskError, maskAgentPayload } from "../src/mask-payload.js";

const ItemSchema = z.object({
  skuId: z.string().min(1),
  title: z.string().min(1),
});

const PayloadSchema = z.object({
  orderNo: z.string().min(1),
  amount: z.number().int().nonnegative(),
  receiver: z.object({ name: z.string().min(1) }),
  items: z.array(ItemSchema),
});

const VALID = {
  orderNo: "DS20260920143000123",
  amount: 23800,
  receiver: { name: "李**" },
  items: [{ skuId: "01J9Z8K2M4N5P6Q7R8S9T0K001", title: "极光 Pro" }],
};

describe("maskAgentPayload —— 白名单裁剪（.strip() 语义）", () => {
  it("(a) 顶层白名单外字段一律丢弃", () => {
    const polluted = {
      ...VALID,
      internalRemark: "内部备注：疑似黄牛",
      userTags: ["vip", "risk"],
      costPrice: 9900,
    };

    const masked = maskAgentPayload(PayloadSchema, polluted);

    expect(masked).toEqual(VALID);
    expect(Object.keys(masked)).toEqual(["orderNo", "amount", "receiver", "items"]);
    expect("internalRemark" in masked).toBe(false);
    expect("userTags" in masked).toBe(false);
    expect("costPrice" in masked).toBe(false);
  });

  it("(b) 嵌套对象与数组项内的未知字段也被丢弃", () => {
    const polluted = {
      ...VALID,
      receiver: {
        name: "李**",
        // 未知字段（真实地址/电话原文）
        phone: "13888888888",
        addressDetail: "文三路 478 号",
      },
      items: [
        {
          skuId: "01J9Z8K2M4N5P6Q7R8S9T0K001",
          title: "极光 Pro",
          costPrice: 9900,
          supplierName: "某供应商",
        },
        {
          skuId: "01J9Z8K2M4N5P6Q7R8S9T0K002",
          title: "极光 Pro 白",
          warehouseCode: "WH-01",
        },
      ],
    };

    const masked = maskAgentPayload(PayloadSchema, polluted);

    expect(masked).toEqual({
      ...VALID,
      items: [...VALID.items, { skuId: "01J9Z8K2M4N5P6Q7R8S9T0K002", title: "极光 Pro 白" }],
    });
    expect(Object.keys(masked.receiver)).toEqual(["name"]);
    expect(masked.items[0]).toEqual(VALID.items[0]);
  });

  it("裁剪结果与原 payload 不共享顶层引用（不修改入参）", () => {
    const polluted = { ...VALID, extra: 1 };
    const masked = maskAgentPayload(PayloadSchema, polluted);

    expect(masked).not.toBe(polluted);
    expect("extra" in polluted).toBe(true);
  });
});

describe("maskAgentPayload —— 失败处理：抛错而非原样返回", () => {
  it("(c) schema 校验失败 → 抛 AgentPayloadMaskError，绝不返回原始 payload", () => {
    const invalid = {
      ...VALID,
      amount: -1, // 违反 nonnegative
      secret: "should-never-be-returned",
    };

    let thrown: unknown;
    try {
      maskAgentPayload(PayloadSchema, invalid, "GET /orders/{orderNo}");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AgentPayloadMaskError);
    const err = thrown as AgentPayloadMaskError;
    expect(err.endpoint).toBe("GET /orders/{orderNo}");
    expect(err.issues.length).toBeGreaterThan(0);
    expect(err.issues.map((issue) => issue.path.join("."))).toContain("amount");
  });

  it("非对象载荷（如 null）→ 同样抛错", () => {
    expect(() => maskAgentPayload(PayloadSchema, null)).toThrow(AgentPayloadMaskError);
  });

  it("错误信息含 issue 路径，且不含 payload 内容（防 PII 落日志）", () => {
    const invalid = { ...VALID, amount: "not-a-number", receiver: { name: "李**" } };
    let thrown: unknown;
    try {
      maskAgentPayload(PayloadSchema, invalid);
    } catch (error) {
      thrown = error;
    }
    const message = (thrown as Error).message;
    expect(message).toContain("amount");
    expect(message).not.toContain("not-a-number");
  });
});

describe("maskAgentPayload —— 黑名单纵深防御（白名单 + 黑名单双保险）", () => {
  it("(d) 黑名单字段即使被写进 schema 定义，也会被二次剔除", () => {
    // 模拟「有人误把敏感字段写进了 Schema」——白名单此刻挡不住它。
    const LeakySchema = z.object({
      orderNo: z.string().min(1),
      costPrice: z.number(), // 红线字段，Schema 误收
      passwordHash: z.string(), // 红线字段，Schema 误收
    });

    const masked = maskAgentPayload(LeakySchema, {
      orderNo: "DS20260920143000123",
      costPrice: 9900,
      passwordHash: "$2b$10$abcdef",
    });

    expect(masked).toEqual({ orderNo: "DS20260920143000123" });
    expect("costPrice" in masked).toBe(false);
    expect("passwordHash" in masked).toBe(false);
  });

  it("开放形状（z.record，如 SkuSpec）内的黑名单键被剔除", () => {
    // `z.record()` 不裁剪键，白名单对它无效——这正是黑名单存在的理由。
    const SpecSchema = z.object({ spec: z.record(z.string(), z.string()) });

    const masked = maskAgentPayload(SpecSchema, {
      spec: { 颜色: "曜石黑", password_hash: "leaked", address_snapshot: "leaked" },
    });

    expect(masked.spec).toEqual({ 颜色: "曜石黑" });
  });

  it("正常载荷经黑名单二次剔除后内容不变（幂等）", () => {
    const masked = maskAgentPayload(PayloadSchema, VALID);
    expect(masked).toEqual(VALID);
  });
});
