#!/usr/bin/env node
/**
 * scripts/export-openapi.ts —— 从 `@dshop/shared` 的 Zod 契约导出 OpenAPI 3.1 文档。
 *
 * 用法：
 *   npx tsx scripts/export-openapi.ts
 *   npm run openapi
 *
 * 输出：
 *   docs/openapi/agent.v1.json   （缩进 2 空格、键按字典序，重复运行字节级一致）
 *
 * 权威来源：
 *   - `packages/shared/src/contracts/agent.ts` 的 `AGENT_ENDPOINTS`（六端点）+ 全部 `Agent*Schema`
 *   - `packages/shared/src/errors.ts` 的 `AGENT_ERROR_META`
 *   - `packages/shared/src/contracts/common.ts` 的 `CONTRACT_VERSION_CURRENT` / `SERVICE_TOKEN_HEADER`
 *   - `docs/07-Agent-API契约.md` §7.2–§7.9
 *
 * 实现侧定案（详见 scripts/README.md）：
 *   - security scheme 名：`ServiceToken`（`type: apiKey`, `in: header`, `name: X-Service-Token`）
 *   - 错误响应 component 名：`AgentErrorResponse`（`{code,message,data}` 统一信封）
 *   - 成功响应 component 名：`<端点 responseSchema>SuccessResponse`（如
 *     `AgentOrderDetailSuccessResponse` = `{code:0, message:"ok", data:<该端点 Schema>}`）；
 *     200 的 body 是**完整信封**，`data` 以 `$ref` 指向端点 data component（07 §7.1）。
 *   - `servers[0]` = `https://api.dshop.example.com`（07 §7.2 Base URL 的 origin），
 *     `paths` 为 `/api/v1/agent/...`（`AGENT_ROUTE_PREFIX` + 端点 path）。
 *
 * 本脚本**只读**契约，唯一副作用是写 `docs/openapi/agent.v1.json`（目录不存在则创建）。
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import * as shared from "@dshop/shared";

/* -------------------------------------------------------------------------- */
/* 路径常量                                                                    */
/* -------------------------------------------------------------------------- */

/** 仓库根（`scripts/` 的上一级）。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** 输出文件（相对仓库根）。 */
const OUTPUT_RELATIVE_PATH = "docs/openapi/agent.v1.json";
const OUTPUT_PATH = resolve(REPO_ROOT, OUTPUT_RELATIVE_PATH);

/** 错误响应 component 名（实现侧定案）。 */
const ERROR_SCHEMA_NAME = "AgentErrorResponse";
/** 成功响应 component 名后缀（`<dataSchema 去掉 Schema>SuccessResponse`）。 */
const SUCCESS_SCHEMA_SUFFIX = "SuccessResponse";
/** 安全方案名（实现侧定案）。 */
const SECURITY_SCHEME_NAME = "ServiceToken";

/* -------------------------------------------------------------------------- */
/* 端点元数据（summary / operationId / 参数与响应 Schema 的绑定）               */
/* -------------------------------------------------------------------------- */

interface EndpointMeta {
  /** OpenAPI `summary`。 */
  readonly summary: string;
  /** OpenAPI `operationId`（稳定、可读、无随机性）。 */
  readonly operationId: string;
  /** 响应体 Schema 的 component 名（= `@dshop/shared` 的导出名）。 */
  readonly responseSchema: string;
  /** 路径参数 Schema（`io: "input"`）。 */
  readonly paramsSchema?: z.ZodType;
  /** 查询参数 Schema（`io: "input"`）。 */
  readonly querySchema?: z.ZodType;
}

/** 端点 path（`AGENT_ENDPOINTS[].path` 原样）→ 元数据。 */
const ENDPOINT_META: Record<string, EndpointMeta> = {
  "/orders": {
    summary: "查询用户订单列表（`userId` 与 `phone` 二选一）",
    operationId: "listAgentOrders",
    responseSchema: "AgentOrderListSchema",
    querySchema: shared.AgentOrderListQuerySchema,
  },
  "/orders/:orderNo": {
    summary: "查询订单详情（主单 + 子单 + 物流轨迹 + 售后汇总）",
    operationId: "getAgentOrderByNo",
    responseSchema: "AgentOrderDetailSchema",
    paramsSchema: shared.AgentOrderDetailParamsSchema,
  },
  "/products/:spuId/specs": {
    summary: "查询商品规格与参数白皮书（**不含**库存数值，仅 `inStock`）",
    operationId: "getAgentProductSpecs",
    responseSchema: "AgentProductSpecsSchema",
    paramsSchema: shared.AgentProductSpecsParamsSchema,
  },
  "/products/:spuId/stock": {
    summary: "查询商品可售库存与 SKU 级预计到货时间",
    operationId: "getAgentProductStock",
    responseSchema: "AgentProductStockSchema",
    paramsSchema: shared.AgentProductStockParamsSchema,
    querySchema: shared.AgentProductStockQuerySchema,
  },
  "/aftersales/:aftersaleNo": {
    summary: "查询售后单详情与时间线（`timeline` 唯一来源为 `aftersale_logs`）",
    operationId: "getAgentAftersaleByNo",
    responseSchema: "AgentAftersaleDetailSchema",
    paramsSchema: shared.AgentAftersaleDetailParamsSchema,
  },
  "/policies/:category": {
    summary: "查询售后政策条款（`category` 支持五类 + `all`）",
    operationId: "getAgentPolicies",
    responseSchema: "AgentPoliciesSchema",
    paramsSchema: shared.AgentPoliciesParamsSchema,
  },
};

/** 响应 component 名 → Schema 对象（六端点 + 错误信封）。 */
function responseSchemaFor(name: string): z.ZodType {
  const map: Record<string, z.ZodType> = {
    AgentOrderListSchema: shared.AgentOrderListSchema,
    AgentOrderDetailSchema: shared.AgentOrderDetailSchema,
    AgentProductSpecsSchema: shared.AgentProductSpecsSchema,
    AgentProductStockSchema: shared.AgentProductStockSchema,
    AgentAftersaleDetailSchema: shared.AgentAftersaleDetailSchema,
    AgentPoliciesSchema: shared.AgentPoliciesSchema,
  };
  const schema = map[name];
  if (schema === undefined) throw new Error(`未知响应 Schema：${name}`);
  return schema;
}

/** 端点 data component 名 → 成功信封 component 名（`XxxSchema` → `XxxSuccessResponse`）。 */
function successResponseSchemaName(dataSchemaName: string): string {
  return `${dataSchemaName.replace(/Schema$/u, "")}${SUCCESS_SCHEMA_SUFFIX}`;
}

/**
 * 现场构造某端点的成功信封 `{code:0, message:"ok", data:<该端点 Schema>}`，
 * 并注册进 zod 全局注册表（名 = `<dataSchema 去掉 Schema>` + `SuccessResponse`）。
 *
 * 注册后 `z.toJSONSchema(..., { reused: "ref" })` 会把 `data` 输出为
 * `$ref: "#/$defs/<dataSchema>"`，不会把端点 Schema 内联重复展开（07 §7.1）。
 */
function successEnvelopeFor(dataSchemaName: string): z.ZodType {
  const envelope = z.object({
    code: z.literal(0),
    message: z.literal(shared.OK_MESSAGE),
    data: responseSchemaFor(dataSchemaName),
  });
  z.globalRegistry.add(envelope, { id: successResponseSchemaName(dataSchemaName) });
  return envelope;
}

/** 参数说明（`in:name` → 描述）。缺失则不带 `description`。 */
const PARAM_DESCRIPTIONS: Record<string, string> = {
  "path:orderNo": "主单号，格式 `^DS\\d{17}$`",
  "path:spuId": "商品 SPU 的 26 位 ULID",
  "path:aftersaleNo": "售后单号，格式 `^AS\\d{11}$`",
  "path:category": "政策分类；`return`/`refund`/`exchange`/`freight`/`warranty` + `all`",
  "query:userId": "会员 26 位 ULID（与 `phone` 二选一，同时提供或同时缺失 → `40001`）",
  "query:phone": "11 位手机号（服务端规范化后 HMAC 比对；与 `userId` 二选一）",
  "query:status": "按主单状态过滤，多值逗号分隔",
  "query:limit": "返回条数，默认 5，取值 1–20",
  "query:cursor": "分页游标（不透明串，取自上一页 `nextCursor`）",
  "query:skuId": "限定单个 SKU（26 位 ULID）",
  "query:quantity": "目标购买数量，默认 1（用于计算 `available`）",
  "query:regionCode": "收货地区码（**预留**：多仓就近判断，一期不使用）",
};

/** 错误响应的 HTTP 状态集合（由 `AGENT_ERROR_META` 推导，排除 200），升序。 */
const ERROR_HTTP_STATUSES: readonly string[] = [
  ...new Set(
    Object.values(shared.AGENT_ERROR_META)
      .map((meta) => meta.http)
      .filter((http) => http !== 200),
  ),
]
  .sort((a, b) => a - b)
  .map((http) => String(http));

/** 某 HTTP 状态对应的全部错误码语义（用于 response `description`）。 */
function errorDescriptionFor(http: number): string {
  const parts = Object.entries(shared.AGENT_ERROR_META)
    .filter(([, meta]) => meta.http === http)
    .map(([code, meta]) => `${code} ${meta.message}`);
  return `失败：统一错误信封 \`{code,message,data}\` —— ${parts.join("；")}`;
}

/* -------------------------------------------------------------------------- */
/* 稳定序列化与深排序                                                          */
/* -------------------------------------------------------------------------- */

/** 深排序对象键（数组保持原序），保证多次运行字节级一致。 */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortDeep(item));
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = sortDeep(source[key]);
    }
    return out;
  }
  return value;
}

/** 稳定 JSON 串（用于内容比较与匿名 Schema 命名）。 */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

/** 匿名 `$defs`（`__schemaN`）的确定性命名。 */
function anonymousName(value: unknown): string {
  const digest = createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
  return `AnonSchema${digest.slice(0, 8)}`;
}

/* -------------------------------------------------------------------------- */
/* 收集 components.schemas                                                     */
/* -------------------------------------------------------------------------- */

/** 已收集的 component schema（键为 component 名）。 */
const componentSchemas = new Map<string, unknown>();
/** 匿名 def 原名（`__schemaN`）→ 确定性名字。 */
const anonymousRenames = new Map<string, string>();

/**
 * 生成某 Schema 的 JSON Schema，并把其 `$defs` 并入 components。
 *
 * @returns 该 Schema 的根 JSON Schema（`reused: "ref"` 时为 `{$ref: "#/$defs/X"}`）。
 */
function jsonSchemaFor(
  schema: z.ZodType,
  io: "input" | "output",
  reused: "ref" | "inline",
): Record<string, unknown> {
  const document = z.toJSONSchema(schema, { io, reused }) as Record<string, unknown>;
  const localDefs = (document["$defs"] ?? {}) as Record<string, unknown>;
  delete document["$defs"];
  delete document["$schema"];

  for (const [rawName, value] of Object.entries(localDefs)) {
    const isAnonymous = rawName.startsWith("__schema");
    const name = isAnonymous ? anonymousName(value) : rawName;
    if (isAnonymous) anonymousRenames.set(rawName, name);
    const existing = componentSchemas.get(name);
    if (existing === undefined) {
      componentSchemas.set(name, value);
      continue;
    }
    if (stableStringify(existing) !== stableStringify(value)) {
      throw new Error(`components.schemas 命名冲突且内容不一致：${name}`);
    }
  }
  return document;
}

/** 递归把 `#/$defs/<name>` 重写为 `#/components/schemas/<name>`（含匿名改名）。 */
function rewriteRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map((item) => rewriteRefs(item));
  if (node !== null && typeof node === "object") {
    const source = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) {
      if (key === "$ref" && typeof value === "string" && value.startsWith("#/$defs/")) {
        const raw = value.slice("#/$defs/".length);
        out[key] = `#/components/schemas/${anonymousRenames.get(raw) ?? raw}`;
      } else {
        out[key] = rewriteRefs(value);
      }
    }
    return out;
  }
  return node;
}

/**
 * 把 `@dshop/shared` 的 `*Schema` 导出注册进 zod 全局注册表（名 = 导出名），
 * 使 `z.toJSONSchema(..., { reused: "ref" })` 产出 `$ref` 而非重复内联。
 *
 * 例外：
 *   - `AgentEnvelopeSchema` 注册为 `AgentErrorResponse`（实现侧定案的名字）；
 *   - `*ParamsSchema` / `*QuerySchema` 不注册：它们只作为 OpenAPI `parameters`
 *     的来源，需要内联展开才能取出 `properties` / `required`。
 */
function registerSharedSchemas(): void {
  for (const [name, value] of Object.entries(shared as unknown as Record<string, unknown>)) {
    if (!name.endsWith("Schema")) continue;
    if (name === "AgentEnvelopeSchema") continue;
    if (name.endsWith("ParamsSchema") || name.endsWith("QuerySchema")) continue;
    if (!(value instanceof z.ZodType)) continue;
    z.globalRegistry.add(value, { id: name });
  }
  z.globalRegistry.add(shared.AgentEnvelopeSchema, { id: ERROR_SCHEMA_NAME });
}

/* -------------------------------------------------------------------------- */
/* 参数                                                                        */
/* -------------------------------------------------------------------------- */

/** 由 Params / Query Schema 生成 OpenAPI `parameters` 数组。 */
function buildParameters(meta: EndpointMeta): unknown[] {
  const parameters: unknown[] = [];

  const pushFrom = (schema: z.ZodType | undefined, location: "path" | "query"): void => {
    if (schema === undefined) return;
    const document = jsonSchemaFor(schema, "input", "inline");
    const properties = (document["properties"] ?? {}) as Record<string, unknown>;
    const required = new Set<string>(
      ((document["required"] ?? []) as unknown[]).filter(
        (value): value is string => typeof value === "string",
      ),
    );
    for (const name of Object.keys(properties)) {
      const description = PARAM_DESCRIPTIONS[`${location}:${name}`];
      const parameter: Record<string, unknown> = {
        name,
        in: location,
        // OpenAPI 规定 path 参数必须 required: true。
        required: location === "path" ? true : required.has(name),
        schema: properties[name],
      };
      if (description !== undefined) parameter["description"] = description;
      parameters.push(parameter);
    }
  };

  pushFrom(meta.paramsSchema, "path");
  pushFrom(meta.querySchema, "query");
  return parameters;
}

/* -------------------------------------------------------------------------- */
/* 组装文档                                                                    */
/* -------------------------------------------------------------------------- */

/** Hono 路径语法 `/orders/:orderNo` → OpenAPI 形式 `/orders/{orderNo}`。 */
function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/gu, "{$1}");
}

function buildDocument(): Record<string, unknown> {
  const paths: Record<string, unknown> = {};

  for (const endpoint of shared.AGENT_ENDPOINTS) {
    const meta = ENDPOINT_META[endpoint.path];
    if (meta === undefined) {
      throw new Error(`AGENT_ENDPOINTS 出现未登记的端点：${endpoint.path}`);
    }

    // 生成响应 Schema 并把 $defs 并入 components（保证用 $ref 而非重复内联）。
    jsonSchemaFor(responseSchemaFor(meta.responseSchema), "output", "ref");
    // 成功信封：{code:0, message:"ok", data:<端点 Schema>}，data 以 $ref 复用端点 component。
    const successSchemaName = successResponseSchemaName(meta.responseSchema);
    jsonSchemaFor(successEnvelopeFor(meta.responseSchema), "output", "ref");

    const responses: Record<string, unknown> = {
      "200": {
        description:
          '成功（07 §7.1：HTTP 200、`code = 0`、`message = "ok"`；`data` 为下表端点 Schema）',
        content: {
          "application/json": {
            schema: { $ref: `#/components/schemas/${successSchemaName}` },
          },
        },
      },
    };
    for (const status of ERROR_HTTP_STATUSES) {
      responses[status] = {
        description: errorDescriptionFor(Number(status)),
        content: {
          "application/json": {
            schema: { $ref: `#/components/schemas/${ERROR_SCHEMA_NAME}` },
          },
        },
      };
    }

    const operation: Record<string, unknown> = {
      operationId: meta.operationId,
      summary: meta.summary,
      tags: ["agent"],
      security: [{ [SECURITY_SCHEME_NAME]: [] }],
      parameters: buildParameters(meta),
      responses,
      "x-agent-scope": endpoint.scope,
      "x-rate-limit-per-min": endpoint.rateLimitPerMin,
      "x-burst": endpoint.burst,
      "x-cache-ttl-seconds": endpoint.cacheTtlSeconds,
    };

    paths[`${shared.AGENT_ROUTE_PREFIX}${toOpenApiPath(endpoint.path)}`] = { get: operation };
  }

  // 错误信封必须出现在 components 中（即使某端点未引用）。
  jsonSchemaFor(shared.AgentEnvelopeSchema, "output", "ref");

  const schemas: Record<string, unknown> = {};
  for (const [name, value] of componentSchemas) {
    schemas[name] = value;
  }

  const document: Record<string, unknown> = {
    openapi: "3.1.0",
    info: {
      title: "DShop Agent API",
      version: shared.CONTRACT_VERSION_CURRENT,
      description:
        "PiEcho Agent 只读接口（GET-only，六端点）。契约版本载体：请求头 `X-Contract-Version`（缺失视为 `1`，不报错）。\n" +
        "权威来源：`packages/shared/src/contracts/agent.ts`（Zod Schema 为唯一真相）。\n" +
        "本文件由 `scripts/export-openapi.ts` 生成，**请勿手改**。",
    },
    servers: [
      {
        url: "https://api.dshop.example.com",
        description: "演示/生产环境（docs/07 §7.2 Base URL 的 origin）",
      },
      {
        url: "http://localhost:8787",
        description: "本地 `wrangler dev`（apps/api/wrangler.jsonc）",
      },
    ],
    tags: [
      {
        name: "agent",
        description:
          "PiEcho Agent 只读接口：仅 GET；非 GET → `405` + `40501`；所有响应经 `maskAgentPayload()` 白名单脱敏。",
      },
    ],
    paths,
    components: {
      securitySchemes: {
        [SECURITY_SCHEME_NAME]: {
          type: "apiKey",
          in: "header",
          name: shared.SERVICE_TOKEN_HEADER,
          description:
            "服务令牌（07 §7.8.1）：**非** Bearer，**不允许**放 query string。明文仅创建时返回一次；服务端存 `HMAC-SHA256(AGENT_TOKEN_PEPPER, token)`。",
        },
      },
      schemas,
    },
  };

  // 统一把 `#/$defs/<name>` 重写为 `#/components/schemas/<name>`（含参数与响应内的引用）。
  return rewriteRefs(document) as Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/* 入口                                                                        */
/* -------------------------------------------------------------------------- */

function main(): void {
  registerSharedSchemas();
  const document = buildDocument();
  const serialized = `${JSON.stringify(sortDeep(document), null, 2)}\n`;

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, serialized, "utf8");

  const components = document["components"] as Record<string, unknown>;
  const schemas = components["schemas"] as Record<string, unknown>;
  const paths = document["paths"] as Record<string, unknown>;

  console.log("[export-openapi] 写出文件：");
  console.log(`  ${OUTPUT_PATH}`);
  console.log(`[export-openapi] 相对路径：${OUTPUT_RELATIVE_PATH}`);
  console.log(`[export-openapi] paths 数量：${Object.keys(paths).length}`);
  console.log(`[export-openapi] components.schemas 数量：${Object.keys(schemas).length}`);
  console.log(`[export-openapi] 字节数：${Buffer.byteLength(serialized, "utf8")}`);
}

main();
