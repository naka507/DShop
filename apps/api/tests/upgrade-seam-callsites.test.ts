/**
 * 升级缝「真实调用点」回归测试（`docs/04` §4.3 / `docs/12` §12.9）。
 *
 * ## 为什么需要这个文件
 *
 * 结构测试 `upgrade-seam-bindings.test.ts` 只能证明**配置侧**干净
 * （默认零绑定、字段可选、无重复键）。它无法证明**代码侧**真的用了这些缝——
 * 一个「工厂函数写好了但没人调用」的缝，在结构测试下完全绿。
 *
 * 本文件补上另一半：断言缝在**真实生产入口**上被真的走到，
 * 且**默认行为零变化**（无绑定时退化为原实现，而非报错或静默跳过）。
 *
 * ## 测试基建纪律（与 `merchant-routes.test.ts` 一致）
 *
 * - D1 用 `helpers/sqlite-d1.ts`（**真实 SQLite 引擎**，跑 `0001_init.sql` 全量 DDL）。
 *   这很重要：S1 的断言是「`task_queue` 表里真的多了一行」，
 *   若用假替身就只是断言了替身自己的行为。
 * - 请求走**真实生产入口** `../src/index.js`，不自建中间件链。
 */

import { signJwt } from "@dshop/auth";
import { TASK_TYPE, getReadDb, getTaskQueue } from "@dshop/services";
import type { TaskEnvelope } from "@dshop/services";
import { JWT_AUDIENCE } from "@dshop/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Env } from "../src/env.js";
import app from "../src/index.js";
import { executeTaskEnvelope } from "../src/jobs/task-queue.js";
import { createSqliteD1 } from "./helpers/sqlite-d1.js";
import type { SqliteD1 } from "./helpers/sqlite-d1.js";

/* -------------------------------------------------------------------------- */
/* 固定数据                                                                     */
/* -------------------------------------------------------------------------- */

const JWT_SECRET = "seam-callsite-test-secret";
const NOW = "2026-09-20T06:30:00.000Z";

const USER_ID = "01J9Z8K2M4N5P6Q7R8S9T0UU01";
const ADDRESS_ID = "01J9Z8K2M4N5P6Q7R8S9T0AA01";
const CART_ITEM_ID = "01J9Z8K2M4N5P6Q7R8S9T0CC01";
const MERCHANT_ID = "01J9Z8K2M4N5P6Q7R8S9T0MM01";
const STORE_ID = "01J9Z8K2M4N5P6Q7R8S9T0SS01";
const CATEGORY_ID = "01J9Z8K2M4N5P6Q7R8S9T0C001";
const PRODUCT_ID = "01J9Z8K2M4N5P6Q7R8S9T0PP01";
const SKU_ID = "01J9Z8K2M4N5P6Q7R8S9T0KK01";

/** 购物车 SKU 的初始库存（锁定后断言用）。 */
const INITIAL_STOCK = 5;

let d1: SqliteD1;
let token: string;

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: d1.database,
    AGENT_TOKEN_PEPPER: "test-pepper",
    PHONE_ENC_KEY: "phone-enc-key",
    PHONE_HASH_PEPPER: "phone-hash-pepper",
    JWT_SECRET,
    ENVIRONMENT: "test",
    ...overrides,
  };
}

/**
 * 播种：用户 + 收货地址 + 购物车行（数量 2）+ 商户/门店/类目/商品/SKU。
 *
 * ⚠️ 列名与 `packages/db/migrations/0001_init.sql` 严格一致
 * （如 `product_skus.sku_code` / `price`，`categories.sort_order`）。
 */
function seed(): void {
  d1.run(
    `INSERT INTO users (id, phone, phone_hash, nickname, status, created_at, updated_at)
     VALUES (?, 'enc', 'hash', '测试用户', 'active', ?, ?)`,
    USER_ID,
    NOW,
    NOW,
  );
  d1.run(
    `INSERT INTO user_addresses
       (id, user_id, receiver_name, receiver_phone, province, city, district, detail, is_default, created_at, updated_at)
     VALUES (?, ?, '张三', '13800000000', '广东省', '深圳市', '南山区', '科技园 1 号', 1, ?, ?)`,
    ADDRESS_ID,
    USER_ID,
    NOW,
    NOW,
  );
  d1.run(
    `INSERT INTO merchants (id, type, name, status, commission_rate_bp, created_at, updated_at)
     VALUES (?, 'self', '自营商户', 'active', 0, ?, ?)`,
    MERCHANT_ID,
    NOW,
    NOW,
  );
  d1.run(
    `INSERT INTO stores (id, merchant_id, name, type, province, city, supports_pickup, status, created_at, updated_at)
     VALUES (?, ?, '默认门店', 'warehouse', '广东省', '深圳市', 0, 'active', ?, ?)`,
    STORE_ID,
    MERCHANT_ID,
    NOW,
    NOW,
  );
  d1.run(
    `INSERT INTO categories (id, parent_id, name, sort_order, status, created_at, updated_at)
     VALUES (?, NULL, '测试类目', 1, 'active', ?, ?)`,
    CATEGORY_ID,
    NOW,
    NOW,
  );
  d1.run(
    `INSERT INTO products (id, merchant_id, category_id, title, status, created_at, updated_at)
     VALUES (?, ?, ?, '测试商品', 'onsale', ?, ?)`,
    PRODUCT_ID,
    MERCHANT_ID,
    CATEGORY_ID,
    NOW,
    NOW,
  );
  d1.run(
    `INSERT INTO product_skus
       (id, product_id, sku_code, spec, price, stock, locked_stock, status, created_at, updated_at)
     VALUES (?, ?, 'SKU-1', '{"颜色":"黑"}', 1999, ${INITIAL_STOCK}, 0, 'active', ?, ?)`,
    SKU_ID,
    PRODUCT_ID,
    NOW,
    NOW,
  );
  d1.run(
    `INSERT INTO cart_items (id, user_id, sku_id, quantity, selected, created_at, updated_at)
     VALUES (?, ?, ?, 2, 1, ?, ?)`,
    CART_ITEM_ID,
    USER_ID,
    SKU_ID,
    NOW,
    NOW,
  );
}

interface CallOptions {
  readonly method?: string;
  readonly body?: unknown;
  readonly idempotencyKey?: string;
}

/** 以 shop 会员身份调真实生产入口。 */
async function call(path: string, options: CallOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {
    "X-Contract-Version": "1",
    Cookie: `dshop_shop_at=${token}`,
  };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.idempotencyKey !== undefined) {
    headers["Idempotency-Key"] = options.idempotencyKey;
  }

  const executionCtx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;

  return await app.request(
    `http://localhost${path}`,
    {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    },
    createEnv(),
    executionCtx,
  );
}

/** 统计 `task_queue` 中某类型任务的行数。 */
async function taskCount(type: string): Promise<number> {
  const rows = await d1.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM task_queue WHERE type = ?`,
    type,
  );
  return rows[0]?.n ?? 0;
}

/** 读某订单的状态。 */
async function orderStatus(orderNo: string): Promise<string | undefined> {
  const rows = await d1.query<{ status: string }>(
    `SELECT status FROM orders WHERE order_no = ?`,
    orderNo,
  );
  return rows[0]?.status;
}

/**
 * 取最近入队的那条 `order.timeout_cancel`，还原成消费侧的 `TaskEnvelope`。
 *
 * 刻意**从表里读**而不是手搓：这样才能验证生产端写入的 payload
 * 与消费端 handler 期望的字段**真的是同一套**。
 */
async function latestTimeoutEnvelope(): Promise<TaskEnvelope> {
  const rows = await d1.query<{ type: string; payload: string }>(
    `SELECT type, payload FROM task_queue WHERE type = ? ORDER BY created_at DESC LIMIT 1`,
    TASK_TYPE.ORDER_TIMEOUT_CANCEL,
  );
  const row = rows[0];
  if (row === undefined) throw new Error("未找到 order.timeout_cancel 任务（生产者未入队？）");
  return { type: TASK_TYPE.ORDER_TIMEOUT_CANCEL, payload: JSON.parse(row.payload) };
}

/** 读购物车 SKU 的（库存, 锁定量）。 */
async function skuStock(): Promise<{ stock: number; locked: number }> {
  const rows = await d1.query<{ stock: number; locked_stock: number }>(
    `SELECT stock, locked_stock FROM product_skus WHERE id = ?`,
    SKU_ID,
  );
  return { stock: rows[0]?.stock ?? -1, locked: rows[0]?.locked_stock ?? -1 };
}
/** 下单并返回订单号（断言状态码由调用方负责；本 API 成功即 200，非 201）。 */
async function placeOrder(idempotencyKey: string): Promise<{ status: number; orderNo?: string }> {
  const res = await call("/api/v1/shop/orders", {
    method: "POST",
    idempotencyKey,
    body: { addressId: ADDRESS_ID },
  });
  if (res.status !== 200) return { status: res.status };
  const body = (await res.json()) as { data: { orderNo: string } };
  return { status: res.status, orderNo: body.data.orderNo };
}

beforeEach(async () => {
  d1 = createSqliteD1();
  seed();

  token = await signJwt({ sub: USER_ID, role: "customer" }, JWT_SECRET, {
    aud: JWT_AUDIENCE.SHOP,
  });
});

afterEach(() => {
  d1.close();
});

/* -------------------------------------------------------------------------- */

describe("S2 升级缝：只读连接来源（`docs/04` §4.3）", () => {
  it("无 `READ_DB` 绑定时 `getReadDb` 返回 `env.DB` 本身 —— 默认零变化", () => {
    const env = createEnv();
    expect(getReadDb(env)).toBe(env.DB);
  });

  it("有 `READ_DB` 绑定时返回副本，**不再是** `env.DB`", () => {
    // 副本必须是**另一个** D1 实例：若两个绑定指向同一对象，这个断言就失去意义。
    const replica = createSqliteD1();
    try {
      const env = createEnv({ READ_DB: replica.database });
      expect(getReadDb(env)).toBe(replica.database);
      expect(getReadDb(env)).not.toBe(env.DB);
    } finally {
      replica.close();
    }
  });

  it("真实生产入口：`GET /shop/products` 与 `/shop/categories` 仍正常（读路径改走 `getReadDb` 后无回归）", async () => {
    const list = await call("/api/v1/shop/products");
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { data: { list: readonly unknown[] } };
    expect(listBody.data.list.length).toBeGreaterThan(0);

    const cats = await call("/api/v1/shop/categories");
    expect(cats.status).toBe(200);

    const detail = await call(`/api/v1/shop/products/${PRODUCT_ID}`);
    expect(detail.status).toBe(200);
  });
});

describe("S1 升级缝：入队 = 真实生产者调用点（`docs/12` §12.9.3）", () => {
  it("无 `TASK_QUEUE` 绑定时 `getTaskQueue` 仍可用（默认走 D1 表实现）", () => {
    const queue = getTaskQueue(createEnv());
    expect(typeof queue.enqueue).toBe("function");
  });

  it("★ 下单成功后 `task_queue` 表里真的多了一条 `order.timeout_cancel` 待办", async () => {
    expect(await taskCount(TASK_TYPE.ORDER_TIMEOUT_CANCEL)).toBe(0);

    const placed = await placeOrder("seam-callsite-1");
    expect(placed.status).toBe(200);
    expect(placed.orderNo).toBeDefined();

    // 生产者调用点成立的**唯一可信证据**：表里真的有行。
    expect(await taskCount(TASK_TYPE.ORDER_TIMEOUT_CANCEL)).toBe(1);

    const rows = await d1.query<{ status: string; attempts: number; payload: string }>(
      `SELECT status, attempts, payload FROM task_queue WHERE type = ?`,
      TASK_TYPE.ORDER_TIMEOUT_CANCEL,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe("pending");
    expect(rows[0]?.attempts).toBe(0);

    // payload 必须带够 handler 用的最小信息，且**不含隐私字段**。
    const payload = JSON.parse(rows[0]?.payload ?? "{}") as Record<string, unknown>;
    expect(payload.orderNo).toBe(placed.orderNo);
    expect(payload.orderId).toBeTypeOf("string");
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("13800000000");
    expect(serialized).not.toContain("科技园");
  });

  it("幂等重放（同 `Idempotency-Key`）**不重复入队**", async () => {
    const first = await placeOrder("seam-callsite-2");
    expect(first.status).toBe(200);
    expect(await taskCount(TASK_TYPE.ORDER_TIMEOUT_CANCEL)).toBe(1);

    const second = await placeOrder("seam-callsite-2");
    // 幂等命中：仍是成功响应，但**没有**第二条任务。
    expect(second.status).toBe(200);
    expect(await taskCount(TASK_TYPE.ORDER_TIMEOUT_CANCEL)).toBe(1);
  });
});

describe("S1 升级缝：消费者出口（Cron 与 Queues 共用一张分发表）", () => {
  it("★ 生产→消费**闭环**：真实入队的 payload 能被 handler 消费，关单并释放锁定库存", async () => {
    const placed = await placeOrder("seam-consume-1");
    expect(placed.status).toBe(200);
    const orderNo = placed.orderNo as string;

    // 下单后：库存 5 中 2 被锁定。
    expect(await skuStock()).toEqual({ stock: INITIAL_STOCK, locked: 2 });

    // 取**生产者真正写入的那条 payload**（而不是手搓一个）：
    // 这才能证明生产端与消费端的契约一致——手搓 payload 会让
    // 「生产端字段名写错」这类缺陷在测试里被掩盖。
    const envelope = await latestTimeoutEnvelope();

    await expect(executeTaskEnvelope(d1.database, envelope)).resolves.toBe(true);

    // 关单 + 释放锁定库存（库存本身不变，锁定量归零）。
    expect(await orderStatus(orderNo)).toBe("CANCELLED");
    expect(await skuStock()).toEqual({ stock: INITIAL_STOCK, locked: 0 });
  });

  it("★ 幂等：同一任务重入两次不会重复释放库存，且第二次不抛错", async () => {
    const placed = await placeOrder("seam-consume-2");
    expect(placed.status).toBe(200);
    const orderNo = placed.orderNo as string;

    const envelope = await latestTimeoutEnvelope();
    await executeTaskEnvelope(d1.database, envelope);
    expect(await skuStock()).toEqual({ stock: INITIAL_STOCK, locked: 0 });
    expect(await orderStatus(orderNo)).toBe("CANCELLED");

    // 第二次执行：订单已是 CANCELLED，必须**不抛错**且不再动库存。
    await expect(executeTaskEnvelope(d1.database, envelope)).resolves.toBe(true);
    expect(await skuStock()).toEqual({ stock: INITIAL_STOCK, locked: 0 });
  });

  it("已支付订单：任务**直接返回不报错**（不误关已付款的单）", async () => {
    const placed = await placeOrder("seam-consume-3");
    expect(placed.status).toBe(200);
    const orderNo = placed.orderNo as string;
    const envelope = await latestTimeoutEnvelope();

    // 模拟支付回调把订单置为已支付。
    d1.run(`UPDATE orders SET status = 'PAID' WHERE order_no = ?`, orderNo);

    await expect(executeTaskEnvelope(d1.database, envelope)).resolves.toBe(true);

    // 已支付的单**不能**被关掉，锁定库存也不能被释放（钱已收，货要发）。
    expect(await orderStatus(orderNo)).toBe("PAID");
    expect(await skuStock()).toEqual({ stock: INITIAL_STOCK, locked: 2 });
  });

  it("未注册的任务类型：返回 `false`（调用方据此 ack + 告警，而非无限重投）", async () => {
    const handled = await executeTaskEnvelope(d1.database, {
      type: "unknown.task.type" as never,
      payload: {},
    });
    expect(handled).toBe(false);
  });
});
