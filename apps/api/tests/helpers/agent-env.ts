/**
 * 测试用最小 Agent 运行环境（内存 D1 + 假限流 DO）。
 *
 * 用途：让 `edge-cache.test.ts` 能走**真实生产入口**（`../src/index.js`）断言
 * 「`Cache-Control` 真的取自 `AGENT_ENDPOINTS[].cacheTtlSeconds`」，
 * 而不是自建一条与生产不同的中间件链。
 *
 * 数据来自 `data/seed-cs/*.json`（真实种子形状），SQL 模式分发。
 * 刻意**不**做完整 SQL 引擎——只覆盖六端点用到的查询形态，
 * 与 `agent-contract.test.ts` 同思路（那份文件保留自己的副本以便独立演进）。
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateServiceToken, hashPhone, hashServiceToken } from "@dshop/auth";

import type { Env } from "../../src/env.js";

/* -------------------------------------------------------------------------- */
/* 种子数据                                                                     */
/* -------------------------------------------------------------------------- */

const SEED_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../data/seed-cs");

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
  spec: Record<string, string>;
  unit_price: number;
  quantity: number;
  subtotal: number;
  created_at: string;
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

type Row = Record<string, unknown>;

const seedOrders = loadSeed<SeedOrder[]>("orders.json");
const seedProducts = loadSeed<SeedProduct[]>("products.json");
// `SeedAttr` 是 interface，**没有隐式索引签名**，不能直接赋给 `Row = Record<string, unknown>`；
// 用展开 `{ ...r }` 生成匿名对象字面量类型即可获得隐式索引签名（与文件内其它种子数组写法一致）。
const seedAttrs: Row[] = loadSeed<SeedAttr[]>("product_attrs.json").map((r) => ({ ...r }));
const seedAftersales = loadSeed<SeedAftersale[]>("aftersales.json");

/** 售后政策种子（`data/seed-cs/seed_cs.sql` 的 `aftersale_policies` 五行）。 */
const policyRows: Row[] = [
  { category: "return", title: "7 天无理由退货规则" },
  { category: "refund", title: "退款处理与到账时效规则" },
  { category: "exchange", title: "换货规则（同型号同规格）" },
  { category: "freight", title: "退换货运费归属规则" },
  { category: "warranty", title: "维修与质保规则（非人为损坏）" },
].map((p, index) => ({
  id: `01J9Z8K2M4N5P6Q7R8S9T0P00${String(index + 1)}`,
  category: p.category,
  title: p.title,
  content: "## 适用范围\n\n本测试用节选正文。",
  version: "1.0.0",
  effective_from: "2026-06-01T00:00:00.000Z",
  effective_to: null,
  status: "effective",
  tags: "[]",
  updated_at: "2026-08-15T02:00:00.000Z",
}));

const merchants: Row[] = [
  { id: "01J9Z8K2M4N5P6Q7R8S9T0V1M1", name: "DShop 自营旗舰店", type: "self" },
];
const stores: Row[] = [
  {
    id: "01J9Z8K2M4N5P6Q7R8S9T0V1R1",
    merchant_id: "01J9Z8K2M4N5P6Q7R8S9T0V1M1",
    name: "杭州仓",
    type: "warehouse",
    province: "浙江省",
    city: "杭州市",
    district: "西湖区",
    supports_pickup: 0,
    status: "active",
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
  o.order_items.map((i) => ({ ...i, order_id: o.id, spec: JSON.stringify(i.spec) })),
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
    id: `${a.id}-L${String(index)}`,
    aftersale_id: a.id,
    ...l,
  })),
);

/* -------------------------------------------------------------------------- */
/* SQL 模式分发                                                                 */
/* -------------------------------------------------------------------------- */

/** 解析 `marker (?, ?, ...)` 的占位符个数与绑定值。 */
function matchIn(sql: string, marker: string, args: unknown[], startIndex: number) {
  const match = new RegExp(`${marker}\\s*\\(([^)]*)\\)`).exec(sql);
  if (match === null) return { values: [] as string[], nextIndex: startIndex };
  const count = (match[1] ?? "").split("?").length - 1;
  return {
    values: args.slice(startIndex, startIndex + count).map(String),
    nextIndex: startIndex + count,
  };
}

const TOKEN_PEPPER = "edge-cache-test-pepper";
const FULL_TOKEN = generateServiceToken();
const TOKEN_ROWS: Row[] = [
  {
    id: "01J9Z8K2M4N5P6Q7R8S9T0T001",
    token_hash: "",
    token_prefix: FULL_TOKEN.slice(0, 16),
    name: "edge-cache-test",
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
];
const users: Row[] = [{ id: "01J9Z8K2M4N5P6Q7R8S9T0Z002", phone_hash: "" }];

function query(sql: string, args: unknown[]): Row[] {
  if (sql.includes("FROM service_tokens"))
    return TOKEN_ROWS.filter((r) => r.token_prefix === args[0]);
  if (sql.includes("UPDATE service_tokens")) return [];

  if (sql.includes("FROM orders") && sql.includes("WHERE order_no = ?")) {
    return orderRows.filter((r) => r.order_no === args[0]);
  }
  if (sql.includes("FROM orders") && sql.includes("WHERE id = ?")) {
    return orderRows.filter((r) => r.id === args[0]);
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
    if (sql.includes("created_at < ?")) index += 3;
    const limit = Number(args[index]);
    return [...rows].slice(0, limit);
  }

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

  if (sql.includes("FROM order_items")) {
    if (sql.includes("order_id IN")) {
      const { values } = matchIn(sql, "order_id IN", args, 0);
      return orderItemRows.filter((r) => values.includes(String(r.order_id)));
    }
    return orderItemRows.filter((r) => r.order_id === args[0]);
  }

  if (sql.includes("FROM order_status_logs")) return [];

  if (sql.includes("FROM merchants")) {
    const { values } = matchIn(sql, "id IN", args, 0);
    return merchants.filter((r) => values.includes(String(r.id)));
  }
  if (sql.includes("FROM stores")) {
    if (sql.includes("merchant_id = ?")) return stores.filter((r) => r.merchant_id === args[0]);
    const { values } = matchIn(sql, "id IN", args, 0);
    return stores.filter((r) => values.includes(String(r.id)));
  }

  if (sql.includes("FROM users")) return users.filter((r) => r.phone_hash === args[0]);

  if (sql.includes("FROM products")) return productRows.filter((r) => r.id === args[0]);
  if (sql.includes("FROM product_skus")) return skuRows.filter((r) => r.product_id === args[0]);
  if (sql.includes("FROM product_attrs")) return seedAttrs.filter((r) => r.spu_id === args[0]);

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

  if (sql.includes("FROM aftersale_logs")) {
    return aftersaleLogRows
      .filter((r) => r.aftersale_id === args[0])
      .sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)));
  }

  if (sql.includes("FROM refunds")) return [];

  if (sql.includes("FROM aftersale_policies")) {
    const now = String(args[0]);
    let rows = policyRows.filter(
      (r) =>
        r.status === "effective" &&
        String(r.effective_from) <= now &&
        (r.effective_to === null || String(r.effective_to) > now),
    );
    if (sql.includes("category = ?")) rows = rows.filter((r) => r.category === args[2]);
    return rows;
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
    return (query(this.sql, [...this.args])[0] ?? null) as T | null;
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
 * 内存 D1。
 *
 * `batch()` 是 `agentAudit` 落库（`agent_call_logs`）的必经入口
 * （`apps/api/src/middleware/agent-audit.ts:170`）；缺了它审计 flush 会每次
 * 告警 `db.batch is not a function`。此处补一个**语义对齐真实 D1** 的实现：
 * 同一事务内按序执行，返回各语句结果数组。
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

/* -------------------------------------------------------------------------- */
/* 对外接口                                                                     */
/* -------------------------------------------------------------------------- */

/** 构造测试用 `Env`（并顺手把令牌哈希算好）。 */
export function createAgentTestEnv(): Env {
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
 * 构造**不带 DO 绑定**的测试 `Env`（S8 升级缝的默认路径）。
 *
 * 用于经**真实入口**验证「绑定缺省 → 应用层自研计数」：
 * `env.AGENT_RATE_LIMITER` 为 `undefined`，中间件必须走默认实现而非报错。
 */
export function createAgentTestEnvWithoutRateLimiter(): Env {
  const env = createAgentTestEnv();
  // 显式删除可选绑定，模拟未在 wrangler.jsonc 声明 durable_objects 的部署
  delete (env as { AGENT_RATE_LIMITER?: unknown }).AGENT_RATE_LIMITER;
  return env;
}

/**
 * 把令牌的 `rate_limit_per_min` 调低，用于经真实入口触发 429。
 *
 * @param perMin 生效限额（令牌维度；端点维度取二者较小值）
 */
export function setTokenRateLimit(perMin: number): void {
  TOKEN_ROWS[0]!.rate_limit_per_min = perMin;
}

/** 以完整四 scope 令牌调用真实入口。 */
export async function agentRequest(
  app: {
    request: (
      input: string,
      init: RequestInit,
      env: Env,
      ctx: ExecutionContext,
    ) => Promise<Response>;
  },
  path: string,
  env: Env,
): Promise<Response> {
  TOKEN_ROWS[0]!.token_hash = await hashServiceToken(TOKEN_PEPPER, FULL_TOKEN);
  users[0]!.phone_hash = await hashPhone("phone-hash-pepper", "13888888888");

  const executionCtx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;

  return app.request(
    path,
    {
      method: "GET",
      headers: { "X-Contract-Version": "1", "X-Service-Token": FULL_TOKEN },
    },
    env,
    executionCtx,
  );
}
