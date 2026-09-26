/**
 * Agent 只读契约六端点的端到端契约测试（`docs/07` §7.2–§7.7）。
 *
 * 策略：
 * - **不连真 D1**：用内存 fake 实现最小 `D1Database` 接口，数据来自
 *   `data/seed-cs/*.json`（真实种子数据形状），逐条 SQL 模式分发。
 * - **不连真 DO**：用假 `DurableObjectNamespace` 返回「放行」的限流判定。
 * - **走真实生产入口**：直接 `import app from "../src/index.js"`，即 `src/index.ts`
 *   的装配（`requestId` → `contractVersion` → `accessLog` → `agentRoutes`
 *   内部 `405 守卫` → `serviceTokenAuth` → `scope` → `rateLimit` → handler）。
 *   因此 401 / 403 / 405 都是真实链路行为，不是桩造出来的。
 *   **不要在本文件自建等价链**——历史上正是自建链掩盖了
 *   「`serviceTokenAuth` 未挂载到生产入口」这一 P0 缺陷。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { generateServiceToken, hashServiceToken, hashPhone } from "@dshop/auth";
import {
  AgentAftersaleDetailSchema,
  AgentOrderDetailSchema,
  AgentOrderListSchema,
  AgentPoliciesSchema,
  AgentProductSpecsSchema,
  AgentProductStockSchema,
} from "@dshop/shared";
import { FORBIDDEN_FIELD_NAMES, stripForbiddenFields } from "@dshop/services";
import { describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env.js";
import app from "../src/index.js";
import { mapOrderDetail } from "../src/routes/agent/mappers.js";
import type * as MappersModule from "../src/routes/agent/mappers.js";
import type { OrderAggregate } from "../src/repositories/orders.js";

/* -------------------------------------------------------------------------- */
/* 种子数据                                                                     */
/* -------------------------------------------------------------------------- */

const SEED_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../data/seed-cs");

function loadSeed<T>(file: string): T {
  return JSON.parse(readFileSync(resolve(SEED_DIR, file), "utf8")) as T;
}

interface SeedSubOrder {
  id: string;
  sub_order_no: string;
  merchant_id: string;
  store_id: string;
  status: string;
  express_company: string | null;
  express_company_code: string | null;
  express_no: string | null;
  shipped_at: string | null;
}
interface SeedItem {
  id: string;
  sub_order_id: string;
  sku_id: string;
  title: string;
  image: string | null;
  spec: Record<string, string>;
  unit_price: number;
  quantity: number;
  subtotal: number;
  created_at: string;
}
interface SeedLog {
  id: string;
  sub_order_id: string | null;
  kind: string;
  remark: string | null;
  occurred_at: string;
}
interface SeedOrder {
  id: string;
  order_no: string;
  user_id: string;
  status: string;
  pay_amount: number;
  address_snapshot: Record<string, string>;
  channel: string;
  paid_at: string | null;
  created_at: string;
  sub_orders: SeedSubOrder[];
  order_items: SeedItem[];
  order_status_logs: SeedLog[];
}
interface SeedSku {
  id: string;
  sku_code: string;
  spec: Record<string, string>;
  price: number;
  market_price: number | null;
  stock: number;
  locked_stock: number;
  restock_eta: string | null;
  status: string;
}
interface SeedProduct {
  id: string;
  merchant_id: string;
  category_path: string[];
  title: string;
  subtitle: string | null;
  main_image: string | null;
  brand: string | null;
  status: string;
  updated_at: string;
  skus: SeedSku[];
}
interface SeedAttr {
  spu_id: string;
  group_name: string;
  attr_name: string;
  attr_value: string;
  unit: string | null;
  sort_order: number;
}
interface SeedAftersale {
  id: string;
  aftersale_no: string;
  order_id: string;
  sub_order_id: string;
  sku_id: string;
  item_title: string;
  quantity: number;
  type: string;
  status: string;
  reason: string | null;
  evidence_urls: string[];
  refund_amount: number;
  return_address: Record<string, string> | null;
  return_express_company: string | null;
  return_express_no: string | null;
  deadline_at: string | null;
  created_at: string;
  updated_at: string;
  aftersale_logs: {
    from_status: string | null;
    to_status: string;
    actor_type: string;
    remark: string | null;
    occurred_at: string;
  }[];
}

const seedOrders = loadSeed<SeedOrder[]>("orders.json");
const seedProducts = loadSeed<SeedProduct[]>("products.json");
const seedAttrs = loadSeed<SeedAttr[]>("product_attrs.json");
const seedAftersales = loadSeed<SeedAftersale[]>("aftersales.json");

const PRO_SPU = "01J9Z8K2M4N5P6Q7R8S9T0V1W2";
const MAIN_ORDER_NO = "DS20260920143000123";
const MAIN_AFTERSALE_NO = "AS20260922001";

/**
 * 售后政策种子（`data/seed-cs/seed_cs.sql` 的 `aftersale_policies` 五行）。
 *
 * ⚠️ `content` 在测试中**为节选**（正文与断言无关，`content` 只受 `z.string()` 约束）；
 * `category`/`title`/`version`/`effective_from`/`effective_to`/`status`/`tags`
 * 与种子 SQL 逐字一致。
 */
const seedPolicies = [
  {
    id: "01J9Z8K2M4N5P6Q7R8S9T0P001",
    category: "return",
    title: "7 天无理由退货规则",
    content: "自确认签收之日起 7 个自然日内…（节选）",
    version: "1.0.0",
    effective_from: "2026-06-01T00:00:00.000Z",
    effective_to: null,
    status: "effective",
    tags: '["无理由","时效","签收","不支持品类"]',
    updated_at: "2026-08-15T02:00:00.000Z",
  },
  {
    id: "01J9Z8K2M4N5P6Q7R8S9T0P002",
    category: "refund",
    title: "退款处理与到账时效规则",
    content: "售后申请经商家（或平台客服介入）审核同意后，进入退款流程。",
    version: "1.0.0",
    effective_from: "2026-06-01T00:00:00.000Z",
    effective_to: null,
    status: "effective",
    tags: '["退款","到账时效","部分退款"]',
    updated_at: "2026-08-15T02:00:00.000Z",
  },
  {
    id: "01J9Z8K2M4N5P6Q7R8S9T0P003",
    category: "exchange",
    title: "换货规则（同型号同规格）",
    content: "签收后 7 个自然日内，商品存在出厂质量问题、功能性故障。",
    version: "1.0.0",
    effective_from: "2026-06-01T00:00:00.000Z",
    effective_to: null,
    status: "effective",
    tags: '["换货","质量问题","同规格"]',
    updated_at: "2026-08-15T02:00:00.000Z",
  },
  {
    id: "01J9Z8K2M4N5P6Q7R8S9T0P004",
    category: "freight",
    title: "退换货运费归属规则",
    content: "经官方售后检测确认存在出厂质量问题、功能性故障由商家承担。",
    version: "1.0.0",
    effective_from: "2026-06-01T00:00:00.000Z",
    effective_to: null,
    status: "effective",
    tags: '["运费","退货","换货","补贴"]',
    updated_at: "2026-08-15T02:00:00.000Z",
  },
  {
    id: "01J9Z8K2M4N5P6Q7R8S9T0P005",
    category: "warranty",
    title: "维修与质保规则（非人为损坏）",
    content: "旗舰电子类产品自签收之日起享 1 年官方全国联保（12 个月）。",
    version: "1.0.0",
    effective_from: "2026-06-01T00:00:00.000Z",
    effective_to: null,
    status: "effective",
    tags: '["质保","保修","人为损坏","进液","进水"]',
    updated_at: "2026-08-15T02:00:00.000Z",
  },
];

/* -------------------------------------------------------------------------- */
/* 内存 D1 fake                                                                 */
/* -------------------------------------------------------------------------- */

type Row = Record<string, unknown>;

const merchants = [{ id: "01J9Z8K2M4N5P6Q7R8S9T0V1M1", name: "DShop 自营旗舰店", type: "self" }];
const stores = [
  {
    id: "01J9Z8K2M4N5P6Q7R8S9T0V1R1",
    merchant_id: "01J9Z8K2M4N5P6Q7R8S9T0V1M1",
    name: "杭州仓",
    type: "warehouse",
    province: "浙江省",
    city: "杭州市",
    district: "西湖区",
    supports_pickup: 0,
  },
  {
    id: "01J9Z8K2M4N5P6Q7R8S9T0V1R2",
    merchant_id: "01J9Z8K2M4N5P6Q7R8S9T0V1M1",
    name: "杭州西湖自提店",
    type: "store",
    province: "浙江省",
    city: "杭州市",
    district: "西湖区",
    supports_pickup: 1,
  },
];

const orderRows: Row[] = seedOrders.map((o) => ({
  id: o.id,
  order_no: o.order_no,
  user_id: o.user_id,
  status: o.status,
  pay_amount: o.pay_amount,
  address_snapshot: JSON.stringify(o.address_snapshot),
  channel: o.channel,
  paid_at: o.paid_at,
  created_at: o.created_at,
}));

const subOrderRows: Row[] = seedOrders.flatMap((o) =>
  o.sub_orders.map((s) => ({ ...s, order_id: o.id })),
);

const orderItemRows: Row[] = seedOrders.flatMap((o) =>
  o.order_items.map((i) => ({
    ...i,
    order_id: o.id,
    spec: JSON.stringify(i.spec),
  })),
);

const orderLogRows: Row[] = seedOrders.flatMap((o) =>
  o.order_status_logs.map((l) => ({ ...l, order_id: o.id })),
);

const productRows: Row[] = seedProducts.map((p) => ({
  id: p.id,
  merchant_id: p.merchant_id,
  category_path: JSON.stringify(p.category_path),
  title: p.title,
  subtitle: p.subtitle,
  main_image: p.main_image,
  brand: p.brand,
  status: p.status,
  updated_at: p.updated_at,
}));

const skuRows: Row[] = seedProducts.flatMap((p) =>
  p.skus.map((s) => ({ ...s, product_id: p.id, spec: JSON.stringify(s.spec) })),
);

const attrRows: Row[] = seedAttrs.map((a) => ({ ...a }));

const aftersaleRows: Row[] = seedAftersales.map((a) => ({
  id: a.id,
  aftersale_no: a.aftersale_no,
  order_id: a.order_id,
  sub_order_id: a.sub_order_id,
  sku_id: a.sku_id,
  item_title: a.item_title,
  quantity: a.quantity,
  type: a.type,
  status: a.status,
  reason: a.reason,
  evidence_urls: JSON.stringify(a.evidence_urls),
  refund_amount: a.refund_amount,
  return_address: a.return_address === null ? null : JSON.stringify(a.return_address),
  return_express_company: a.return_express_company,
  return_express_no: a.return_express_no,
  deadline_at: a.deadline_at,
  refunded_at: null,
  created_at: a.created_at,
  updated_at: a.updated_at,
}));

const aftersaleLogRows: Row[] = seedAftersales.flatMap((a) =>
  a.aftersale_logs.map((l, index) => ({
    id: `${a.id}-L${index}`,
    aftersale_id: a.id,
    ...l,
  })),
);

const policyRows: Row[] = seedPolicies.map((p) => ({ ...p }));

/** 令牌行（测试内固定一个明文令牌）。 */
const TOKEN_PEPPER = "test-pepper";
const FULL_TOKEN = generateServiceToken();
const READONLY_PRODUCT_TOKEN = generateServiceToken();
const TOKEN_ROWS: Row[] = [
  {
    id: "01J9Z8K2M4N5P6Q7R8S9T0T001",
    token_hash: "",
    token_prefix: FULL_TOKEN.slice(0, 16),
    name: "full",
    scopes: JSON.stringify([
      "agent:order:read",
      "agent:product:read",
      "agent:aftersale:read",
      "agent:policy:read",
    ]),
    status: "active",
    expires_at: "2099-01-01T00:00:00.000Z",
    rate_limit_per_min: 600,
  },
  {
    id: "01J9Z8K2M4N5P6Q7R8S9T0T002",
    token_hash: "",
    token_prefix: READONLY_PRODUCT_TOKEN.slice(0, 16),
    name: "product-only",
    scopes: JSON.stringify(["agent:product:read"]),
    status: "active",
    expires_at: "2099-01-01T00:00:00.000Z",
    rate_limit_per_min: 600,
  },
];

const users = [
  { id: "01J9Z8K2M4N5P6Q7R8S9T0Z002", phone_hash: "" },
  { id: "01J9Z8K2M4N5P6Q7R8S9T0Z001", phone_hash: "" },
  { id: "01J9Z8K2M4N5P6Q7R8S9T0Z003", phone_hash: "" },
];

function countPlaceholders(fragment: string): number {
  return (fragment.match(/\?/g) ?? []).length;
}

function matchIn(
  sql: string,
  marker: string,
  args: unknown[],
  startIndex: number,
): {
  values: string[];
  nextIndex: number;
} {
  const match = new RegExp(`${marker}\\s*\\(([^)]*)\\)`).exec(sql);
  if (match === null) return { values: [], nextIndex: startIndex };
  const count = countPlaceholders(match[1] ?? "");
  const values = args.slice(startIndex, startIndex + count).map(String);
  return { values, nextIndex: startIndex + count };
}

function query(sql: string, args: unknown[]): Row[] {
  // --- service_tokens ---
  if (sql.includes("FROM service_tokens")) {
    return TOKEN_ROWS.filter((r) => r.token_prefix === args[0]);
  }
  if (sql.includes("UPDATE service_tokens")) return [];

  // --- orders ---
  if (sql.includes("FROM orders") && sql.includes("WHERE id = ?")) {
    return orderRows.filter((r) => r.id === args[0]);
  }
  if (sql.includes("FROM orders") && sql.includes("WHERE order_no = ?")) {
    return orderRows.filter((r) => r.order_no === args[0]);
  }
  if (sql.includes("FROM orders") && sql.includes("ORDER BY created_at DESC")) {
    let index = 0;
    const userId = String(args[index]);
    index += 1;
    let rows = orderRows.filter((r) => r.user_id === userId);
    if (sql.includes("status IN")) {
      const { values, nextIndex } = matchIn(sql, "status IN", args, index);
      index = nextIndex;
      rows = rows.filter((r) => values.includes(String(r.status)));
    }
    if (sql.includes("created_at < ?")) {
      const createdAt = String(args[index]);
      const orderNo = String(args[index + 2]);
      index += 3;
      rows = rows.filter(
        (r) =>
          String(r.created_at) < createdAt ||
          (String(r.created_at) === createdAt && String(r.order_no) < orderNo),
      );
    }
    const limit = Number(args[index]);
    return [...rows]
      .sort(
        (a, b) =>
          String(b.created_at).localeCompare(String(a.created_at)) ||
          String(b.order_no).localeCompare(String(a.order_no)),
      )
      .slice(0, limit);
  }

  // --- sub_orders ---
  if (sql.includes("FROM sub_orders")) {
    if (sql.includes("order_id IN")) {
      const { values } = matchIn(sql, "order_id IN", args, 0);
      return subOrderRows.filter((r) => values.includes(String(r.order_id)));
    }
    if (sql.includes("sub_order_no FROM sub_orders")) {
      return subOrderRows.filter((r) => r.id === args[0]);
    }
    return subOrderRows.filter((r) => r.order_id === args[0]);
  }

  // --- order_items ---
  if (sql.includes("FROM order_items")) {
    if (sql.includes("order_id IN")) {
      const { values } = matchIn(sql, "order_id IN", args, 0);
      return orderItemRows.filter((r) => values.includes(String(r.order_id)));
    }
    return orderItemRows.filter((r) => r.order_id === args[0]);
  }

  // --- order_status_logs（仅 trace） ---
  if (sql.includes("FROM order_status_logs")) {
    return orderLogRows.filter((r) => r.order_id === args[0] && r.kind === "trace");
  }

  // --- merchants / stores ---
  if (sql.includes("FROM merchants")) {
    const { values } = matchIn(sql, "id IN", args, 0);
    return merchants.filter((r) => values.includes(r.id));
  }
  if (sql.includes("FROM stores")) {
    if (sql.includes("merchant_id = ?")) {
      return stores.filter((r) => r.merchant_id === args[0]);
    }
    const { values } = matchIn(sql, "id IN", args, 0);
    return stores.filter((r) => values.includes(r.id));
  }

  // --- users ---
  if (sql.includes("FROM users")) {
    return users.filter((r) => r.phone_hash === args[0]);
  }

  // --- products / skus / attrs ---
  if (sql.includes("FROM products")) {
    return productRows.filter((r) => r.id === args[0]);
  }
  if (sql.includes("FROM product_skus")) {
    return skuRows.filter((r) => r.product_id === args[0]);
  }
  if (sql.includes("FROM product_attrs")) {
    return attrRows.filter((r) => r.spu_id === args[0]);
  }

  // --- aftersales ---
  if (sql.includes("SELECT evidence_urls FROM aftersales")) {
    return aftersaleRows.filter((r) => r.id === args[0]);
  }
  if (sql.includes("FROM aftersales") && sql.includes("aftersale_no = ?")) {
    return aftersaleRows.filter((r) => r.aftersale_no === args[0]);
  }
  if (sql.includes("FROM aftersales")) {
    if (sql.includes("order_id IN")) {
      const { values } = matchIn(sql, "order_id IN", args, 0);
      return aftersaleRows.filter((r) => values.includes(String(r.order_id)));
    }
    return aftersaleRows.filter((r) => r.order_id === args[0]);
  }

  // --- aftersale_logs ---
  if (sql.includes("FROM aftersale_logs")) {
    return aftersaleLogRows
      .filter((r) => r.aftersale_id === args[0])
      .sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)));
  }

  // --- refunds ---
  if (sql.includes("FROM refunds")) return [];

  // --- aftersale_policies ---
  if (sql.includes("FROM aftersale_policies")) {
    const now = String(args[0]);
    let rows = policyRows.filter(
      (r) =>
        r.status === "effective" &&
        String(r.effective_from) <= now &&
        (r.effective_to === null || String(r.effective_to) > now),
    );
    if (sql.includes("category = ?")) {
      rows = rows.filter((r) => r.category === args[2]);
    }
    return rows.sort((a, b) => String(b.effective_from).localeCompare(String(a.effective_from)));
  }

  return [];
}

class FakeStatement {
  constructor(
    private readonly sql: string,
    private readonly args: readonly unknown[] = [],
  ) {}

  bind(...args: unknown[]): FakeStatement {
    return new FakeStatement(this.sql, args);
  }

  async first<T>(): Promise<T | null> {
    const rows = query(this.sql, [...this.args]);
    return (rows[0] ?? null) as T | null;
  }

  async all<T>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
    return {
      results: query(this.sql, [...this.args]) as T[],
      success: true,
      meta: { duration: 0 },
    };
  }

  async run(): Promise<{ success: true; meta: Record<string, unknown> }> {
    return { success: true, meta: { changes: 1 } };
  }
}

/**
 * 内存 fake D1。
 *
 * `batch()` 供 `agentAudit` 落库（`agent_call_logs`）使用
 * （`apps/api/src/middleware/agent-audit.ts:170`）：语义对齐真实 D1，
 * 同一事务内按序执行并返回各语句结果数组。本文件不校验审计内容。
 */
function createFakeDb(): D1Database {
  return {
    prepare: (sql: string) => new FakeStatement(sql),
    batch: async (statements: readonly unknown[]) =>
      statements.map(() => ({ success: true, meta: { changes: 1 } })),
  } as unknown as D1Database;
}

/** 假限流 DO：恒放行。 */
function createFakeRateLimiter(): DurableObjectNamespace {
  const stub = {
    fetch: async () =>
      Response.json({
        allowed: true,
        count: 1,
        limit: 120,
        remaining: 119,
        retryAfterSeconds: 60,
      }),
  };
  return {
    idFromName: (name: string) => ({ name }) as unknown as DurableObjectId,
    get: () => stub as unknown as DurableObjectStub,
  } as unknown as DurableObjectNamespace;
}

function createEnv(): Env {
  return {
    DB: createFakeDb(),
    AGENT_RATE_LIMITER: createFakeRateLimiter(),
    AGENT_TOKEN_PEPPER: TOKEN_PEPPER,
    PHONE_ENC_KEY: "phone-enc-key",
    PHONE_HASH_PEPPER: "phone-hash-pepper",
    JWT_SECRET: "jwt-secret",
    ENVIRONMENT: "test",
  };
}

/**
 * 返回**真实生产入口**（`src/index.ts` 的默认导出）。
 *
 * ⚠️ 这里**故意不自建中间件链**。历史上本文件曾自己
 * `new Hono()` 并手动挂 `requestId`/`contractVersion`/`serviceTokenAuth`，
 * 结果 28 个用例全绿，而生产 `agentRoutes` 其实**从未挂载**
 * `serviceTokenAuth`——六端点在生产环境全部 403。
 * 自建链与生产链一旦分叉，测试就失去意义。
 */
function createApp(): typeof app {
  return app;
}

const executionCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

interface CallOptions {
  method?: string;
  token?: string | null;
}

async function call(path: string, options: CallOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { "X-Contract-Version": "1" };
  if (options.token !== null) headers["X-Service-Token"] = options.token ?? FULL_TOKEN;
  return createApp().request(
    path,
    { method: options.method ?? "GET", headers },
    createEnv(),
    executionCtx,
  );
}

async function getJson<T>(path: string, options: CallOptions = {}): Promise<T> {
  const res = await call(path, options);
  expect(res.status, `GET ${path} 应返回 200`).toBe(200);
  return (await res.json()) as T;
}

/* -------------------------------------------------------------------------- */
/* 令牌哈希（延迟到测试运行时用真实 pepper 计算）                                */
/* -------------------------------------------------------------------------- */

async function primeTokenHashes(): Promise<void> {
  TOKEN_ROWS[0]!.token_hash = await hashServiceToken(TOKEN_PEPPER, FULL_TOKEN);
  TOKEN_ROWS[1]!.token_hash = await hashServiceToken(TOKEN_PEPPER, READONLY_PRODUCT_TOKEN);
  users[0]!.phone_hash = await hashPhone("phone-hash-pepper", "13888888888");
  users[1]!.phone_hash = await hashPhone("phone-hash-pepper", "13912345678");
  users[2]!.phone_hash = await hashPhone("phone-hash-pepper", "13712345678");
}

/* -------------------------------------------------------------------------- */
/* 1. 六端点输出经契约 Schema 解析成功                                          */
/* -------------------------------------------------------------------------- */

describe("六端点输出通过 Agent*Schema", () => {
  it("GET /orders/{orderNo}（种子 DS20260920143000123）", async () => {
    await primeTokenHashes();
    const body = await getJson<{ code: number; message: string; data: unknown }>(
      `/api/v1/agent/orders/${MAIN_ORDER_NO}`,
    );
    expect(body.code).toBe(0);
    expect(body.message).toBe("ok");

    const parsed = AgentOrderDetailSchema.safeParse(body.data);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("GET /orders（种子用户 01J9Z8K2M4N5P6Q7R8S9T0Z002）", async () => {
    await primeTokenHashes();
    const body = await getJson<{ data: unknown }>(
      "/api/v1/agent/orders?userId=01J9Z8K2M4N5P6Q7R8S9T0Z002",
    );
    const parsed = AgentOrderListSchema.safeParse(body.data);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("GET /orders?phone=（种子手机号 13888888888）", async () => {
    await primeTokenHashes();
    const body = await getJson<{ data: { userId: string; list: unknown[] } }>(
      "/api/v1/agent/orders?phone=13888888888",
    );
    expect(body.data.userId).toBe("01J9Z8K2M4N5P6Q7R8S9T0Z002");
    expect(AgentOrderListSchema.safeParse(body.data).success).toBe(true);
  });

  it("GET /orders?phone= 查不到用户 → 空列表（非 404）", async () => {
    await primeTokenHashes();
    const res = await call("/api/v1/agent/orders?phone=13000000000");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      code: number;
      data: { list: unknown[]; hasMore: boolean };
    };
    expect(body.code).toBe(0);
    expect(body.data.list).toEqual([]);
    expect(body.data.hasMore).toBe(false);
  });

  it("GET /products/{spuId}/specs（种子 Pro SPU）", async () => {
    await primeTokenHashes();
    const body = await getJson<{ data: unknown }>(`/api/v1/agent/products/${PRO_SPU}/specs`);
    const parsed = AgentProductSpecsSchema.safeParse(body.data);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("GET /products/{spuId}/stock（种子 Pro SPU）", async () => {
    await primeTokenHashes();
    const body = await getJson<{ data: unknown }>(`/api/v1/agent/products/${PRO_SPU}/stock`);
    const parsed = AgentProductStockSchema.safeParse(body.data);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("GET /aftersales/{aftersaleNo}（种子 AS20260922001）", async () => {
    await primeTokenHashes();
    const body = await getJson<{ data: unknown }>(`/api/v1/agent/aftersales/${MAIN_AFTERSALE_NO}`);
    const parsed = AgentAftersaleDetailSchema.safeParse(body.data);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("GET /policies/{category}（种子 warranty）", async () => {
    await primeTokenHashes();
    const body = await getJson<{ data: unknown }>("/api/v1/agent/policies/warranty");
    const parsed = AgentPoliciesSchema.safeParse(body.data);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("GET /policies/all 聚合五类", async () => {
    await primeTokenHashes();
    const body = await getJson<{ data: { items: unknown[] } }>("/api/v1/agent/policies/all");
    expect(body.data.items).toHaveLength(5);
    expect(AgentPoliciesSchema.safeParse(body.data).success).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. 脱敏：receiver 与禁止字段                                                  */
/* -------------------------------------------------------------------------- */

describe("脱敏", () => {
  it("订单详情的 receiver 不含原文姓名 / 手机号 / 详细地址", async () => {
    await primeTokenHashes();
    const res = await call(`/api/v1/agent/orders/${MAIN_ORDER_NO}`);
    const raw = await res.text();

    // 种子原文（data/seed-cs/orders.json）
    expect(raw).not.toContain("李晓雨");
    expect(raw).not.toContain("13888888888");
    expect(raw).not.toContain("文三路 478 号华星时代广场 A 座 1203 室");
    expect(raw).not.toContain("310012");

    const receiver = (JSON.parse(raw) as { data: { receiver: Record<string, string> } }).data
      .receiver;
    expect(receiver.name).toBe("李**");
    expect(receiver.phone).toBe("138****8888");
    expect(receiver.region).toBe("浙江省 杭州市 西湖区");
    expect(receiver.addressMasked).toBe("浙江省 杭州市 西湖区 ***");
  });

  it("整个响应体不出现任何禁止字段名（含 address_snapshot / password_hash / raw_callback / evidence_urls）", async () => {
    await primeTokenHashes();
    const paths = [
      `/api/v1/agent/orders/${MAIN_ORDER_NO}`,
      "/api/v1/agent/orders?userId=01J9Z8K2M4N5P6Q7R8S9T0Z002",
      `/api/v1/agent/products/${PRO_SPU}/specs`,
      `/api/v1/agent/products/${PRO_SPU}/stock`,
      `/api/v1/agent/aftersales/${MAIN_AFTERSALE_NO}`,
      "/api/v1/agent/policies/all",
    ];

    for (const path of paths) {
      const res = await call(path);
      const body = (await res.json()) as { data: unknown };
      const keys = new Set<string>();
      const collect = (value: unknown): void => {
        if (Array.isArray(value)) {
          value.forEach(collect);
          return;
        }
        if (typeof value !== "object" || value === null) return;
        for (const [key, child] of Object.entries(value)) {
          keys.add(key);
          collect(child);
        }
      };
      collect(body.data);

      const normalized = (key: string): string => key.replace(/[_\-\s]/g, "").toLowerCase();
      const forbidden = new Set(FORBIDDEN_FIELD_NAMES.map(normalized));
      const leaked = [...keys].filter((key) => forbidden.has(normalized(key)));
      expect(leaked, `${path} 泄漏禁止字段`).toEqual([]);

      // `stripForbiddenFields` 必须**不改变**响应内容（即本来就没有可剔除的键）
      expect(stripForbiddenFields(body.data)).toEqual(body.data);
    }
  });

  it("GET /orders 列表的响应体不含手机号明文与地址快照", async () => {
    await primeTokenHashes();
    const res = await call("/api/v1/agent/orders?phone=13888888888");
    const raw = await res.text();
    expect(raw).not.toContain("13888888888");
    expect(raw).not.toContain("address_snapshot");
    expect(raw).not.toContain("文三路");
  });
});

/* -------------------------------------------------------------------------- */
/* 3. 售后：只给 evidenceCount 数字                                             */
/* -------------------------------------------------------------------------- */

describe("售后端点", () => {
  it("只下发 evidenceCount 数字，不下发凭证 URL", async () => {
    await primeTokenHashes();
    const res = await call(`/api/v1/agent/aftersales/${MAIN_AFTERSALE_NO}`);
    const raw = await res.text();

    expect(raw).not.toContain("evidence_urls");
    expect(raw).not.toContain("as20260922001-1.jpg");

    const data = (JSON.parse(raw) as { data: { evidenceCount: unknown } }).data;
    expect(typeof data.evidenceCount).toBe("number");
    expect(data.evidenceCount).toBe(2); // 种子 AS20260922001 有 2 张凭证
  });

  it("returnAddress 已脱敏（不泄漏退货收件人与电话原文）", async () => {
    await primeTokenHashes();
    const res = await call(`/api/v1/agent/aftersales/${MAIN_AFTERSALE_NO}`);
    const raw = await res.text();
    expect(raw).not.toContain("极光售后服务中心");
    expect(raw).not.toContain("057188880000");
    expect(raw).not.toContain("三墩镇西园一路 8 号 DShop 杭州仓退货收货组");

    const data = (JSON.parse(raw) as { data: { returnAddress: Record<string, string> } }).data;
    expect(data.returnAddress.phone).toBe("0571****0000");
    expect(data.returnAddress.addressMasked).toBe("浙江省 杭州市 西湖区 ***");
  });

  it("无生效条款的分类 → 404 + 40404", async () => {
    await primeTokenHashes();
    const res = await call("/api/v1/agent/policies/unknown");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: number };
    expect(body.code).toBe(40001);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. 主单状态聚合                                                              */
/* -------------------------------------------------------------------------- */

describe("主单状态聚合", () => {
  it("DS20260920143000123 的两个子单均为 SHIPPED → 主单 SHIPPED", async () => {
    const order = seedOrders.find((o) => o.order_no === MAIN_ORDER_NO);
    expect(order).toBeDefined();
    expect(order!.sub_orders.map((s) => s.status)).toEqual(["SHIPPED", "SHIPPED"]);

    const aggregate: OrderAggregate = {
      order: {
        id: order!.id,
        order_no: order!.order_no,
        user_id: order!.user_id,
        status: order!.status as OrderAggregate["order"]["status"],
        pay_amount: order!.pay_amount,
        address_snapshot: JSON.stringify(order!.address_snapshot),
        channel: order!.channel,
        paid_at: order!.paid_at,
        created_at: order!.created_at,
      },
      subOrders: order!.sub_orders.map((s) => ({
        subOrder: {
          id: s.id,
          sub_order_no: s.sub_order_no,
          order_id: order!.id,
          merchant_id: s.merchant_id,
          store_id: s.store_id,
          status: s.status as "PAID" | "SHIPPED" | "COMPLETED" | "CANCELLED",
          express_company: s.express_company,
          express_company_code: s.express_company_code,
          express_no: s.express_no,
          shipped_at: s.shipped_at,
        },
        merchant: merchants[0]!,
        store: stores[0]!,
        items: order!.order_items
          .filter((item) => item.sub_order_id === s.id)
          .map((item) => ({
            id: item.id,
            sub_order_id: item.sub_order_id,
            sku_id: item.sku_id,
            title: item.title,
            image: item.image,
            spec: JSON.stringify(item.spec),
            unit_price: item.unit_price,
            quantity: item.quantity,
            subtotal: item.subtotal,
          })),
        traces: [],
      })),
      aftersales: [
        {
          id: "01J9Z8K2M4N5P6Q7R8S9T0F001",
          order_id: order!.id,
          status: "WAIT_BUYER_RETURN",
          refund_amount: 12900,
        },
        {
          id: "01J9Z8K2M4N5P6Q7R8S9T0F002",
          order_id: order!.id,
          status: "REFUNDED",
          refund_amount: 12900,
        },
      ],
    };

    const detail = mapOrderDetail(aggregate);
    expect(detail.status).toBe("SHIPPED");
    expect(detail.statusText).toBe("已发货");
    expect(detail.subOrders).toHaveLength(2);
    expect(detail.subOrders.every((s) => s.statusText === "已发货")).toBe(true);
    expect(detail.aftersaleSummary).toEqual({
      hasAftersale: true,
      openCount: 1, // WAIT_BUYER_RETURN 未终结；REFUNDED 已终结
      refundedAmount: 12900,
    });
    expect(AgentOrderDetailSchema.safeParse(detail).success).toBe(true);
  });

  it("含 CANCELLED 子单 → 剔除后其余 PAID → 主单 PAID（DS20260921103000456）", async () => {
    const order = seedOrders.find((o) => o.order_no === "DS20260921103000456");
    const detail = mapOrderDetail({
      order: {
        id: order!.id,
        order_no: order!.order_no,
        user_id: order!.user_id,
        status: "PAID",
        pay_amount: order!.pay_amount,
        address_snapshot: JSON.stringify(order!.address_snapshot),
        channel: order!.channel,
        paid_at: order!.paid_at,
        created_at: order!.created_at,
      },
      subOrders: order!.sub_orders.map((s) => ({
        subOrder: {
          id: s.id,
          sub_order_no: s.sub_order_no,
          order_id: order!.id,
          merchant_id: s.merchant_id,
          store_id: s.store_id,
          status: s.status as "PAID" | "SHIPPED" | "COMPLETED" | "CANCELLED",
          express_company: s.express_company,
          express_company_code: s.express_company_code,
          express_no: s.express_no,
          shipped_at: s.shipped_at,
        },
        merchant: merchants[0]!,
        store: stores[0]!,
        items: order!.order_items
          .filter((item) => item.sub_order_id === s.id)
          .map((item) => ({
            id: item.id,
            sub_order_id: item.sub_order_id,
            sku_id: item.sku_id,
            title: item.title,
            image: item.image,
            spec: JSON.stringify(item.spec),
            unit_price: item.unit_price,
            quantity: item.quantity,
            subtotal: item.subtotal,
          })),
        traces: [],
      })),
      aftersales: [],
    });
    expect(detail.status).toBe("PAID");
    expect(detail.subOrders.map((s) => s.express)).toEqual([null, null]);
  });
});

/* -------------------------------------------------------------------------- */
/* 5–7. 只读保证 / 鉴权 / scope                                                 */
/* -------------------------------------------------------------------------- */

describe("只读保证与鉴权", () => {
  it("非 GET 方法 → 405 + code 40501 + Allow: GET", async () => {
    await primeTokenHashes();
    const res = await call(`/api/v1/agent/orders/${MAIN_ORDER_NO}`, { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
    const body = (await res.json()) as { code: number; data: unknown };
    expect(body.code).toBe(40501);
    expect(body.data).toBeNull();
  });

  it("DELETE /policies/all → 405 + 40501", async () => {
    await primeTokenHashes();
    const res = await call("/api/v1/agent/policies/all", { method: "DELETE" });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
    expect(((await res.json()) as { code: number }).code).toBe(40501);
  });

  it("缺 X-Service-Token → 401 + code 40101", async () => {
    const res = await call(`/api/v1/agent/orders/${MAIN_ORDER_NO}`, { token: null });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: number; data: unknown };
    expect(body.code).toBe(40101);
    expect(body.data).toBeNull();
  });

  it("scope 不含所需 → 403 + code 40301", async () => {
    await primeTokenHashes();
    const res = await call(`/api/v1/agent/orders/${MAIN_ORDER_NO}`, {
      token: READONLY_PRODUCT_TOKEN,
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: number };
    expect(body.code).toBe(40301);
  });

  it("有 agent:product:read 时可访问 /products/{spuId}/specs", async () => {
    await primeTokenHashes();
    const res = await call(`/api/v1/agent/products/${PRO_SPU}/specs`, {
      token: READONLY_PRODUCT_TOKEN,
    });
    expect(res.status).toBe(200);
  });
});

/* -------------------------------------------------------------------------- */
/* 边界：不存在的资源                                                            */
/* -------------------------------------------------------------------------- */

describe("404 语义", () => {
  it("订单不存在 → 404 + 40401", async () => {
    await primeTokenHashes();
    const res = await call("/api/v1/agent/orders/DS20260101000000001");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: number }).code).toBe(40401);
  });

  it("订单号格式非法 → 400 + 40001", async () => {
    await primeTokenHashes();
    const res = await call("/api/v1/agent/orders/not-an-order-no");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: number }).code).toBe(40001);
  });

  it("商品不存在 → 404 + 40402", async () => {
    await primeTokenHashes();
    const res = await call("/api/v1/agent/products/01J9Z8K2M4N5P6Q7R8S9T0V1Z9/specs");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: number }).code).toBe(40402);
  });

  it("售后单不存在 → 404 + 40403", async () => {
    await primeTokenHashes();
    const res = await call("/api/v1/agent/aftersales/AS20260101001");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: number }).code).toBe(40403);
  });

  it("userId 与 phone 同时提供 → 400 + 40001", async () => {
    await primeTokenHashes();
    const res = await call(
      "/api/v1/agent/orders?userId=01J9Z8K2M4N5P6Q7R8S9T0Z002&phone=13888888888",
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: number }).code).toBe(40001);
  });

  it("畸形游标 → 400 + 40001（不得静默降级为空列表）", async () => {
    await primeTokenHashes();
    const res = await call(
      "/api/v1/agent/orders?userId=01J9Z8K2M4N5P6Q7R8S9T0Z002&cursor=!!!not-base64url!!!",
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: number }).code).toBe(40001);
  });

  it("两者都缺失 → 400 + 40001", async () => {
    await primeTokenHashes();
    const res = await call("/api/v1/agent/orders");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: number }).code).toBe(40001);
  });
});

/* -------------------------------------------------------------------------- */
/* 生产入口装配回归（P0 护栏）                                                   */
/* -------------------------------------------------------------------------- */

/*
 * 背景：M0 期间 `serviceTokenAuth` 曾**从未挂载到生产入口**——
 * 六端点在真实环境全部返回 403，而当时的 28 个用例全绿，
 * 因为测试自己 `new Hono()` 拼了一条与生产不同的链。
 *
 * 下面这组用例不信任 `createApp()` 的注释，而是直接断言
 * **真实入口**必须表现出的鉴权语义。任何一次「忘记挂载鉴权中间件」
 * 都会让这里立刻变红。
 */
describe("生产入口装配（P0 护栏）", () => {
  it("真实入口在缺令牌时返回 401 + 40101（而非 403）", async () => {
    await primeTokenHashes();
    const res = await app.request(
      `/api/v1/agent/orders/${MAIN_ORDER_NO}`,
      { method: "GET", headers: { "X-Contract-Version": "1" } },
      createEnv(),
      executionCtx,
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: number }).code).toBe(40101);
  });

  it("真实入口对非 GET 先返 405（早于鉴权，不泄露令牌有效性）", async () => {
    await primeTokenHashes();
    // 故意不带令牌：若鉴权被错误地提到 405 守卫之前，这里会变成 401。
    const res = await app.request(
      `/api/v1/agent/orders/${MAIN_ORDER_NO}`,
      { method: "POST", headers: { "X-Contract-Version": "1" } },
      createEnv(),
      executionCtx,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
    expect(((await res.json()) as { code: number }).code).toBe(40501);
  });

  it("真实入口对无效令牌返回 401 + 40101", async () => {
    await primeTokenHashes();
    const res = await app.request(
      `/api/v1/agent/orders/${MAIN_ORDER_NO}`,
      {
        method: "GET",
        headers: {
          "X-Contract-Version": "1",
          "X-Service-Token": "dshop_svc_aaaaaaaaaaaaaaaaaaaaaaaa_zzzzzz",
        },
      },
      createEnv(),
      executionCtx,
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: number }).code).toBe(40101);
  });

  it("真实入口对合法令牌放行至业务层（不再是 403）", async () => {
    await primeTokenHashes();
    const res = await app.request(
      `/api/v1/agent/orders/${MAIN_ORDER_NO}`,
      {
        method: "GET",
        headers: { "X-Contract-Version": "1", "X-Service-Token": FULL_TOKEN },
      },
      createEnv(),
      executionCtx,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { code: number }).code).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 单一出口脱敏（`maskAgentPayload()`，07 §7.8.2 / M0 ★ 必交付项）              */
/* -------------------------------------------------------------------------- */

/*
 * 本节构造「mapper 输出被污染」的场景：把 `cost_price` / `password_hash`
 * 两个红线字段塞进 `mapOrderDetail()` 的返回值，然后断言**最终响应体里不含它们**。
 *
 * 手段：`vi.resetModules()` + `vi.doMock` 包装真实 `mappers.ts`，再**动态 import
 * 真实生产入口** `../src/index.js`。**仍然走生产装配**（不自建中间件链），
 * 只是让 mapper 多吐两个字段——检验的就是「响应路径是否真的经过脱敏器」。
 *
 * ⚠️ 必须放在文件末尾：`vi.resetModules()` 会清空模块注册表。
 */

describe("单一出口脱敏（maskAgentPayload）", () => {
  it("mapper 输出被污染（多带 cost_price / password_hash）→ 最终响应体不含该字段", async () => {
    vi.resetModules();
    vi.doMock("../src/routes/agent/mappers.js", async (importOriginal) => {
      const actual = await importOriginal<typeof MappersModule>();
      return {
        ...actual,
        mapOrderDetail: (aggregate: OrderAggregate) => ({
          ...actual.mapOrderDetail(aggregate),
          cost_price: 9900,
          password_hash: "$2b$10$leakedhash",
        }),
      };
    });

    try {
      await primeTokenHashes();
      // 动态 import：拿到挂了 mock 的**真实生产入口**
      const { default: pollutedApp } = await import("../src/index.js");

      const res = await pollutedApp.request(
        `/api/v1/agent/orders/${MAIN_ORDER_NO}`,
        {
          method: "GET",
          headers: { "X-Contract-Version": "1", "X-Service-Token": FULL_TOKEN },
        },
        createEnv(),
        executionCtx,
      );

      expect(res.status).toBe(200);
      const raw = await res.text();

      // 结构性保证：白名单外字段一律丢弃
      expect(raw).not.toContain("cost_price");
      expect(raw).not.toContain("password_hash");
      expect(raw).not.toContain("leakedhash");

      const data = (JSON.parse(raw) as { data: Record<string, unknown> }).data;
      expect(Object.keys(data)).not.toContain("cost_price");
      expect(Object.keys(data)).not.toContain("password_hash");
      // 正常字段仍在（脱敏器没有误伤）
      expect(data.orderNo).toBe(MAIN_ORDER_NO);
      expect(AgentOrderDetailSchema.safeParse(data).success).toBe(true);
    } finally {
      vi.doUnmock("../src/routes/agent/mappers.js");
      vi.resetModules();
    }
  });
});
