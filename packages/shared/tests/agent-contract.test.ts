/**
 * 跨仓库契约锁测试。
 *
 * 用 **PiEcho 侧真实 fixture**（`tests/fixtures/pi-echo/*.json`，原样复制，见 PROVENANCE.md）
 * 反向验证 DShop 契约中心的 Zod Schema —— 这是 `src/contracts/agent.ts` 文件头
 * 「响应形状逐字对齐 PiEcho 侧 `tests/contract/fixtures/*.success.json`」这一断言的
 * 唯一可执行证据。
 *
 * 纪律：若真实 fixture 被 Schema 拒绝，**不得**为通过测试而放宽 Schema 或改写 fixture；
 * 应如实暴露并在回报中逐条列出。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";

import {
  AGENT_ENDPOINTS,
  AgentAftersaleDetailSchema,
  AgentOrderDetailSchema,
  AgentOrderListSchema,
  AgentPoliciesSchema,
  AgentProductSpecsSchema,
  AgentProductStockSchema,
} from "../src/contracts/agent.js";
import { AGENT_SCOPE } from "../src/enums.js";
import {
  AGENT_ERROR_CODES,
  AgentEnvelopeSchema,
  httpStatusFor,
} from "../src/errors.js";

/* -------------------------------------------------------------------------- */
/* fixture 读取                                                                */
/* -------------------------------------------------------------------------- */

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "pi-echo",
);

/** 读取并解析 fixture；文件名固定，缺失即测试失败（fail loud）。 */
function readFixture(fileName: string): unknown {
  const raw = readFileSync(join(FIXTURE_DIR, fileName), "utf8");
  return JSON.parse(raw) as unknown;
}

/**
 * `safeParse` 包装：失败时抛出**含完整 zod issue 路径**的错误，否则返回解析后的值。
 *
 * 之所以不直接用 `expect(result.success).toBe(true)`，是因为那样失败信息里
 * 看不到具体哪个 JSON 路径不匹配，无法诊断。
 */
function parseOrThrow(schema: ZodType, value: unknown, label: string): unknown {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
        return `    - [${path}] ${issue.message}`;
      })
      .join("\n");
    throw new Error(`${label} 校验失败（${result.error.issues.length} 个 issue）：\n${issues}`);
  }
  return result.data;
}

/** 断言 zod 校验通过；失败时 vitest 会展示 zod issue 列表。 */
function expectValid(schema: ZodType, value: unknown, label: string): void {
  const result = schema.safeParse(value);
  const issues = result.success
    ? []
    : result.error.issues.map((issue) => ({
        path: issue.path.join(".") || "(root)",
        message: issue.message,
      }));
  expect(issues, `${label} 存在不匹配项`).toEqual([]);
}

/* -------------------------------------------------------------------------- */
/* 1. success fixture：信封 + 端点 data Schema                                  */
/* -------------------------------------------------------------------------- */

const SUCCESS_CASES: ReadonlyArray<{
  readonly file: string;
  readonly dataSchema: ZodType;
}> = [
  { file: "order.success.json", dataSchema: AgentOrderDetailSchema },
  { file: "orders.success.json", dataSchema: AgentOrderListSchema },
  { file: "product-specs.success.json", dataSchema: AgentProductSpecsSchema },
  { file: "product-stock.success.json", dataSchema: AgentProductStockSchema },
  { file: "aftersale.success.json", dataSchema: AgentAftersaleDetailSchema },
  { file: "policies.success.json", dataSchema: AgentPoliciesSchema },
];

describe("契约锁 · PiEcho success fixture → DShop Schema", () => {
  it("覆盖全部 6 个 success fixture", () => {
    expect(SUCCESS_CASES).toHaveLength(6);
  });

  for (const { file, dataSchema } of SUCCESS_CASES) {
    it(`${file}：信封 + data 均通过`, () => {
      const fixture = readFixture(file);

      // 外层信封（{ code, message, data }）
      expectValid(AgentEnvelopeSchema, fixture, `${file} 信封`);
      const envelope = parseOrThrow(AgentEnvelopeSchema, fixture, `${file} 信封`) as {
        code: number;
        message: string;
        data: unknown;
      };
      expect(envelope.code, `${file} 成功码应为 0`).toBe(AGENT_ERROR_CODES.OK);
      expect(envelope.message, `${file} 成功 message 应为 "ok"`).toBe("ok");

      // data 字段（端点专属 Schema）
      expectValid(dataSchema, envelope.data, `${file} data`);
    });
  }
});

/* -------------------------------------------------------------------------- */
/* 2. error fixture：信封 + 错误码集合 + HTTP 映射                              */
/* -------------------------------------------------------------------------- */

const VALID_ERROR_CODES: readonly number[] = Object.values(AGENT_ERROR_CODES);

const ERROR_CASES: ReadonlyArray<{
  readonly file: string;
  readonly expectCode: number;
  readonly expectHttp: number;
}> = [
  { file: "order.error.json", expectCode: 40401, expectHttp: 404 },
  { file: "orders.error.json", expectCode: 40001, expectHttp: 400 },
  { file: "product-specs.error.json", expectCode: 40402, expectHttp: 404 },
  { file: "product-stock.error.json", expectCode: 42901, expectHttp: 429 },
  { file: "aftersale.error.json", expectCode: 40403, expectHttp: 404 },
  { file: "policies.error.json", expectCode: 40404, expectHttp: 404 },
];

describe("契约锁 · PiEcho error fixture → DShop 错误码表", () => {
  it("覆盖全部 6 个 error fixture", () => {
    expect(ERROR_CASES).toHaveLength(6);
  });

  for (const { file, expectCode, expectHttp } of ERROR_CASES) {
    it(`${file}：信封 + code 合法 + httpStatusFor 合理`, () => {
      const fixture = readFixture(file);

      expectValid(AgentEnvelopeSchema, fixture, `${file} 信封`);
      const envelope = parseOrThrow(AgentEnvelopeSchema, fixture, `${file} 信封`) as {
        code: number;
        message: string;
        data: unknown;
      };

      // code 落在 ERROR_CODE 合法取值集合内
      expect(
        VALID_ERROR_CODES,
        `${file} code=${envelope.code} 不在 AGENT_ERROR_CODES 取值集合内`,
      ).toContain(envelope.code);
      expect(envelope.code, `${file} code`).toBe(expectCode);

      // 失败响应 data 为 null
      expect(envelope.data, `${file} 失败响应 data 应为 null`).toBeNull();

      // httpStatusFor 映射合理（4xx/5xx，且等于错误码表登记值）
      const http = httpStatusFor(envelope.code);
      expect(http, `${file} httpStatusFor(${envelope.code})`).toBe(expectHttp);
      expect(http, `${file} 错误码应映射到 4xx/5xx`).toBeGreaterThanOrEqual(400);
      expect(http, `${file} 错误码应映射到 4xx/5xx`).toBeLessThanOrEqual(599);
    });
  }
});

/* -------------------------------------------------------------------------- */
/* 3. AGENT_ENDPOINTS 内部一致性                                               */
/* -------------------------------------------------------------------------- */

/** 文件头注释表格（agent.ts L8–L16）逐条照录。 */
const EXPECTED_ENDPOINTS: ReadonlyArray<{
  readonly path: string;
  readonly scope: string;
  readonly rateLimitPerMin: number;
  readonly burst: number;
  readonly cacheTtlSeconds: number;
}> = [
  { path: "/orders", scope: "agent:order:read", rateLimitPerMin: 120, burst: 20, cacheTtlSeconds: 10 },
  { path: "/orders/:orderNo", scope: "agent:order:read", rateLimitPerMin: 120, burst: 20, cacheTtlSeconds: 10 },
  { path: "/products/:spuId/specs", scope: "agent:product:read", rateLimitPerMin: 300, burst: 20, cacheTtlSeconds: 60 },
  { path: "/products/:spuId/stock", scope: "agent:product:read", rateLimitPerMin: 300, burst: 20, cacheTtlSeconds: 30 },
  { path: "/aftersales/:aftersaleNo", scope: "agent:aftersale:read", rateLimitPerMin: 120, burst: 20, cacheTtlSeconds: 10 },
  { path: "/policies/:category", scope: "agent:policy:read", rateLimitPerMin: 60, burst: 20, cacheTtlSeconds: 300 },
];

describe("AGENT_ENDPOINTS 内部一致性", () => {
  it("恰好 6 条端点", () => {
    expect(AGENT_ENDPOINTS).toHaveLength(6);
  });

  it("path 唯一", () => {
    const paths = AGENT_ENDPOINTS.map((e) => e.path);
    expect(new Set(paths).size, `重复 path：${paths.join(", ")}`).toBe(paths.length);
  });

  it("path 使用 Hono :param 语法，不得出现 {param}", () => {
    for (const endpoint of AGENT_ENDPOINTS) {
      expect(endpoint.path, `${endpoint.path} 不应含 {`).not.toContain("{");
      expect(endpoint.path, `${endpoint.path} 不应含 }`).not.toContain("}");
      const segments = endpoint.path.split("/").filter((s) => s.length > 0);
      for (const segment of segments) {
        if (segment.startsWith(":")) {
          expect(segment, `非法路径参数段：${segment}`).toMatch(/^:[A-Za-z][A-Za-z0-9]*$/);
        } else {
          expect(segment, `路径段不应含 : —— ${segment}`).not.toContain(":");
        }
      }
    }
  });

  it("scope 属于 AGENT_SCOPE 枚举合法值", () => {
    const validScopes: readonly string[] = Object.values(AGENT_SCOPE);
    for (const endpoint of AGENT_ENDPOINTS) {
      expect(
        validScopes,
        `${endpoint.path} 的 scope=${endpoint.scope} 不在 AGENT_SCOPE 内`,
      ).toContain(endpoint.scope);
    }
  });

  it("rateLimitPerMin / burst / cacheTtlSeconds 均为正整数", () => {
    for (const endpoint of AGENT_ENDPOINTS) {
      for (const field of ["rateLimitPerMin", "burst", "cacheTtlSeconds"] as const) {
        const value = endpoint[field];
        expect(Number.isInteger(value), `${endpoint.path}.${field} 须为整数`).toBe(true);
        expect(value, `${endpoint.path}.${field} 须为正整数`).toBeGreaterThan(0);
      }
    }
  });

  it("数值与文件头注释表格逐条一致", () => {
    const actual = AGENT_ENDPOINTS.map((e) => ({
      path: e.path,
      scope: e.scope,
      rateLimitPerMin: e.rateLimitPerMin,
      burst: e.burst,
      cacheTtlSeconds: e.cacheTtlSeconds,
    }));
    expect(actual).toEqual([...EXPECTED_ENDPOINTS]);
  });

  it("每个端点都有非空 cacheKeyPrefix 且唯一", () => {
    const prefixes = AGENT_ENDPOINTS.map((e) => e.cacheKeyPrefix);
    for (const prefix of prefixes) {
      expect(prefix.length).toBeGreaterThan(0);
    }
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});
