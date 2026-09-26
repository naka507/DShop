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
 * ## 本文件锁定的缺陷（对抗性复核确认）
 *
 * - **P0-1 关单过早**：任务在下单约 1 分钟后就被消费并关单，而非 `pay_deadline`
 *   之后。修法 = 生产者带 `delaySeconds`（传输层延迟）+ handler 二次校验
 *   `pay_deadline` 并**延后重排**（`TaskResult` 协议）。
 * - **P1-2 槽位饥饿**：未注册类型的 `pending` 行占满可运行槽位，饿死关单任务。
 * - **P1-1 关单与释放锁定不原子**：`locked_stock` 永久泄漏。修法 = 合并进
 *   一个 `db.batch()` + 批内 `EXISTS` 守卫（含 TOCTOU 竞态）。
 *
 * ## 测试基建纪律（与 `merchant-routes.test.ts` 一致）
 *
 * - D1 用 `helpers/sqlite-d1.ts`（**真实 SQLite 引擎**，跑 `0001_init.sql` 全量 DDL）。
 *   这很重要：S1 的断言是「`task_queue` 表里真的多了一行」，
 *   若用假替身就只是断言了替身自己的行为。
 * - 请求走**真实生产入口** `../src/index.js`，不自建中间件链。
 */

import { signJwt } from "@dshop/auth";
import { D1TaskQueue, TASK_TYPE, getReadDb, getTaskQueue } from "@dshop/services";
import type { TaskEnvelope } from "@dshop/services";
import { JWT_AUDIENCE } from "@dshop/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Env } from "../src/env.js";
import app from "../src/index.js";
import { queue } from "../src/jobs/index.js";
import { consumeTaskQueue, executeTaskEnvelope } from "../src/jobs/task-queue.js";
import {
  cancelUnpaidOrder,
  findOrderStatusById,
} from "../src/repositories/shop-orders.js";
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

/** 购物车行数量（下单锁定量）。 */
const CART_QUANTITY = 2;

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
     VALUES (?, ?, ?, ${CART_QUANTITY}, 1, ?, ?)`,
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
  /** 环境覆盖（S2 副本测试用）。 */
  readonly env?: Partial<Env>;
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
    createEnv(options.env),
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

/** 读某订单的 `pay_deadline`（ISO 串）。 */
async function orderPayDeadline(orderNo: string): Promise<string | undefined> {
  const rows = await d1.query<{ pay_deadline: string | null }>(
    `SELECT pay_deadline FROM orders WHERE order_no = ?`,
    orderNo,
  );
  return rows[0]?.pay_deadline ?? undefined;
}

/** 读某订单的 id。 */
async function orderIdOf(orderNo: string): Promise<string> {
  const rows = await d1.query<{ id: string }>(`SELECT id FROM orders WHERE order_no = ?`, orderNo);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`未找到订单 ${orderNo}`);
  return id;
}

/** `task_queue` 里某类型的全部行（按创建时间倒序）。 */
interface TimeoutTaskRow {
  readonly id: string;
  readonly status: string;
  readonly run_at: string;
  readonly attempts: number;
  readonly payload: string;
}

async function timeoutTaskRows(): Promise<TimeoutTaskRow[]> {
  return await d1.query<TimeoutTaskRow>(
    `SELECT id, status, run_at, attempts, payload FROM task_queue
      WHERE type = ? ORDER BY created_at DESC`,
    TASK_TYPE.ORDER_TIMEOUT_CANCEL,
  );
}

/**
 * 取最近入队的那条 `order.timeout_cancel`，还原成消费侧的 `TaskEnvelope`。
 *
 * 刻意**从表里读**而不是手搓：这样才能验证生产端写入的 payload
 * 与消费端 handler 期望的字段**真的是同一套**。
 */
async function latestTimeoutEnvelope(): Promise<TaskEnvelope> {
  const rows = await timeoutTaskRows();
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

/** 统计某订单的「关单」状态日志条数（原子性 / 幂等断言用）。 */
async function cancelledLogCount(orderId: string): Promise<number> {
  const rows = await d1.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM order_status_logs WHERE order_id = ? AND to_status = 'CANCELLED'`,
    orderId,
  );
  return rows[0]?.n ?? 0;
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

/**
 * 把最近那条关单任务的 `run_at` 强行改到过去。
 *
 * 用来模拟「传输层延迟被绕过」：时钟漂移 / 手工重放 / 有人直接 `INSERT` 一行。
 * 此时任务**立刻可被消费**，正确性只能靠 handler 的 `pay_deadline` 二次校验。
 */
function bypassTransportDelay(taskId: string): void {
  d1.run(
    `UPDATE task_queue SET run_at = ? WHERE id = ?`,
    new Date(Date.now() - 60_000).toISOString(),
    taskId,
  );
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

  it("★ 真实生产入口：`READ_DB` 指向**另一个内容不同**的库时，响应里出现副本的值", async () => {
    // 这条用例是「缝真的被走到」的**唯一可信证据**：
    // 把 `catalog.ts` 的 `getReadDb` 改回 `env.DB` 后，本用例必然失败
    // （主库的标题是「测试商品」，副本的是「副本商品」）。
    const replica = createSqliteD1();
    try {
      replica.run(
        `INSERT INTO products (id, merchant_id, category_id, title, status, created_at, updated_at)
         VALUES (?, ?, ?, '副本商品', 'onsale', ?, ?)`,
        PRODUCT_ID,
        MERCHANT_ID,
        CATEGORY_ID,
        NOW,
        NOW,
      );

      const res = await call("/api/v1/shop/products", { env: { READ_DB: replica.database } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { list: readonly { title: string }[] } };
      const titles = body.data.list.map((item) => item.title);
      expect(titles).toContain("副本商品");
      expect(titles).not.toContain("测试商品");
    } finally {
      replica.close();
    }
  });
});

describe("S1 升级缝：入队 = 真实生产者调用点（`docs/12` §12.9.3）", () => {
  it("无 `TASK_QUEUE` 绑定时 `getTaskQueue` 仍可用（默认走 D1 表实现）", () => {
    // 等价可判定断言：不只看「有 enqueue 方法」，而是**具体实现类**。
    expect(getTaskQueue(createEnv())).toBeInstanceOf(D1TaskQueue);
  });

  it("★ 下单成功后 `task_queue` 表里真的多了一条 `order.timeout_cancel` 待办", async () => {
    expect(await taskCount(TASK_TYPE.ORDER_TIMEOUT_CANCEL)).toBe(0);

    const placed = await placeOrder("seam-callsite-1");
    expect(placed.status).toBe(200);
    expect(placed.orderNo).toBeDefined();

    // 生产者调用点成立的**唯一可信证据**：表里真的有行。
    expect(await taskCount(TASK_TYPE.ORDER_TIMEOUT_CANCEL)).toBe(1);

    const rows = await timeoutTaskRows();
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe("pending");
    expect(rows[0]?.attempts).toBe(0);

    // payload 必须带够 handler 用的最小信息，且**不含隐私字段**。
    // ★ 键集合等值断言（而非 `not.toContain` 黑名单）：能顺带抓住
    //   字段名写错（如 `order_id`）与「多加了一个隐私字段」两类缺陷。
    const payload = JSON.parse(rows[0]?.payload ?? "{}") as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["createdAtMs", "orderId", "orderNo"]);
    expect(payload.orderNo).toBe(placed.orderNo);
    expect(payload.orderId).toBeTypeOf("string");
    expect(payload.createdAtMs).toBeTypeOf("number");
  });

  it("★ P0-1 传输层延迟：`run_at` ≈ `pay_deadline`（而非入队时刻）", async () => {
    const placed = await placeOrder("seam-delay-1");
    const orderNo = placed.orderNo as string;

    const payDeadline = await orderPayDeadline(orderNo);
    expect(payDeadline).toBeDefined();

    const rows = await timeoutTaskRows();
    const runAt = rows[0]?.run_at ?? "";
    // 修复前：`run_at` 写死为 now → 任务在下单后 1 分钟内就被 Cron 消费并关单。
    // 允许 ≤1 秒的舍入误差：`delaySeconds` 是整秒（`Math.ceil`），
    // 而 `run_at` 以「入队那一刻」为基准，两者天然差不超过 1 秒。
    expect(Math.abs(Date.parse(runAt) - Date.parse(payDeadline ?? ""))).toBeLessThanOrEqual(1000);
    expect(Date.parse(runAt)).toBeGreaterThan(Date.now() + 14 * 60_000);
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
  it("★ P0-1 支付期限回归：`pay_deadline` 在未来 → 订单**不被关单**，任务延后到 `pay_deadline`", async () => {
    const placed = await placeOrder("seam-consume-future");
    const orderNo = placed.orderNo as string;
    expect(await skuStock()).toEqual({ stock: INITIAL_STOCK, locked: CART_QUANTITY });

    const rows = await timeoutTaskRows();
    const taskId = rows[0]?.id as string;
    const payDeadline = await orderPayDeadline(orderNo);

    // 模拟「传输层延迟被绕过」：任务立刻可被消费（时钟漂移 / 手工重放 / 直接 INSERT）。
    bypassTransportDelay(taskId);

    const result = await consumeTaskQueue(d1.database, Date.now());

    // ★ 核心断言：**绝不关单**，而是请求延后到 `pay_deadline`。
    expect(await orderStatus(orderNo)).toBe("PENDING_PAYMENT");
    expect(await skuStock()).toEqual({ stock: INITIAL_STOCK, locked: CART_QUANTITY });
    expect(result.deferred).toBe(1);
    expect(result.succeeded).toBe(0);

    const after = await timeoutTaskRows();
    expect(after[0]?.status).toBe("pending");
    expect(after[0]?.run_at).toBe(payDeadline);
    // 延后**不消耗** attempts（否则一次时钟漂移就会把任务推进死信）。
    expect(after[0]?.attempts).toBe(0);
  });

  it("★ P0-1 支付期限回归：`pay_deadline` 在过去 → 关单 + 锁定归零", async () => {
    const placed = await placeOrder("seam-consume-past");
    const orderNo = placed.orderNo as string;
    const orderId = await orderIdOf(orderNo);

    // 把期限改到过去（等价于「期限真的到了」）。
    d1.run(
      `UPDATE orders SET pay_deadline = ? WHERE id = ?`,
      new Date(Date.now() - 60_000).toISOString(),
      orderId,
    );
    const rows = await timeoutTaskRows();
    bypassTransportDelay(rows[0]?.id as string);

    const result = await consumeTaskQueue(d1.database, Date.now());

    expect(await orderStatus(orderNo)).toBe("CANCELLED");
    expect(await skuStock()).toEqual({ stock: INITIAL_STOCK, locked: 0 });
    expect(result.succeeded).toBe(1);
    expect(result.deferred).toBe(0);
  });

  it("★ P1-2 槽位饥饿：60 条未注册类型不占槽位，关单任务仍被执行", async () => {
    const placed = await placeOrder("seam-starve-1");
    const orderNo = placed.orderNo as string;
    const orderId = await orderIdOf(orderNo);

    d1.run(
      `UPDATE orders SET pay_deadline = ? WHERE id = ?`,
      new Date(Date.now() - 60_000).toISOString(),
      orderId,
    );
    const rows = await timeoutTaskRows();
    bypassTransportDelay(rows[0]?.id as string);

    // 60 > TASK_QUEUE_BATCH_SIZE(50)：修复前它们会把可运行槽位全部占满。
    const past = new Date(Date.now() - 120_000).toISOString();
    for (let i = 0; i < 60; i += 1) {
      d1.run(
        `INSERT INTO task_queue
           (id, type, payload, status, attempts, run_at, last_error, created_at, updated_at)
         VALUES (?, 'unknown.future_type', '{}', 'pending', 0, ?, NULL, ?, ?)`,
        `01J9Z8K2M4N5P6Q7R8S9T0UN${String(i).padStart(2, "0")}`,
        past,
        past,
        past,
      );
    }

    const result = await consumeTaskQueue(d1.database, Date.now());

    // ★ 关单任务**被执行**（修复前会被 50 条未注册行挤掉，永远不执行）。
    expect(await orderStatus(orderNo)).toBe("CANCELLED");
    expect(result.skipped).toBe(60);

    // 未注册行**保持 pending**（既有定案：不消耗 attempts，回滚版本后仍可处理）。
    const unregistered = await d1.query<{ n: number; status: string }>(
      `SELECT COUNT(*) AS n, status FROM task_queue WHERE type = 'unknown.future_type'`,
    );
    expect(unregistered[0]?.n).toBe(60);
    expect(unregistered[0]?.status).toBe("pending");
  });

  it("★ P1-1 原子性：关单状态日志恒为 1 条（重复消费不产生第二条）", async () => {
    const placed = await placeOrder("seam-atomic-1");
    const orderNo = placed.orderNo as string;
    const orderId = await orderIdOf(orderNo);

    d1.run(
      `UPDATE orders SET pay_deadline = ? WHERE id = ?`,
      new Date(Date.now() - 60_000).toISOString(),
      orderId,
    );
    const rows = await timeoutTaskRows();
    bypassTransportDelay(rows[0]?.id as string);

    await consumeTaskQueue(d1.database, Date.now());
    expect(await orderStatus(orderNo)).toBe("CANCELLED");
    expect(await cancelledLogCount(orderId)).toBe(1);

    // 再消费一次（任务已 done，订单已 CANCELLED）——不得产生第二条日志。
    await consumeTaskQueue(d1.database, Date.now());
    expect(await cancelledLogCount(orderId)).toBe(1);
    expect(await skuStock()).toEqual({ stock: INITIAL_STOCK, locked: 0 });
  });

  it("★ P1-1 TOCTOU 竞态：读状态后被支付 → `cancelUnpaidOrder` 返回 `false` 且**不动锁定**", async () => {
    const placed = await placeOrder("seam-toctou-1");
    const orderNo = placed.orderNo as string;
    const orderId = await orderIdOf(orderNo);

    // ① 仓储读判：此刻仍是待支付（handler 的「提前短路」就是基于这个读）。
    const before = await findOrderStatusById(d1.database, orderId);
    expect(before?.status).toBe("PENDING_PAYMENT");

    // ② 竞态：在两次调用之间订单被支付（真实场景 = 支付回调并发）。
    d1.run(`UPDATE orders SET status = 'PAID' WHERE id = ?`, orderId);

    // ③ 关单：必须返回 `false`，且 batch 内所有后续语句因 EXISTS 守卫**全部空转**。
    const cancelled = await cancelUnpaidOrder(d1.database, {
      orderId,
      nowIso: new Date().toISOString(),
      skuQuantities: [{ skuId: SKU_ID, quantity: CART_QUANTITY }],
    });

    expect(cancelled).toBe(false);
    expect(await orderStatus(orderNo)).toBe("PAID");
    // ★ 钱已收，货要发：锁定**一分都不能被释放**。
    expect(await skuStock()).toEqual({ stock: INITIAL_STOCK, locked: CART_QUANTITY });
    expect(await cancelledLogCount(orderId)).toBe(0);
  });

  it("★ 生产→消费**闭环**：真实入队的 payload 能被 handler 消费（已过期限时关单并释放锁定）", async () => {
    const placed = await placeOrder("seam-consume-1");
    expect(placed.status).toBe(200);
    const orderNo = placed.orderNo as string;
    const orderId = await orderIdOf(orderNo);

    // 下单后：库存 5 中 2 被锁定。
    expect(await skuStock()).toEqual({ stock: INITIAL_STOCK, locked: CART_QUANTITY });

    // 取**生产者真正写入的那条 payload**（而不是手搓一个）：
    // 这才能证明生产端与消费端的契约一致——手搓 payload 会让
    // 「生产端字段名写错」这类缺陷在测试里被掩盖。
    const envelope = await latestTimeoutEnvelope();
    d1.run(
      `UPDATE orders SET pay_deadline = ? WHERE id = ?`,
      new Date(Date.now() - 60_000).toISOString(),
      orderId,
    );

    await expect(executeTaskEnvelope(d1.database, envelope)).resolves.toEqual({ handled: true });

    // 关单 + 释放锁定库存（库存本身不变，锁定量归零）。
    expect(await orderStatus(orderNo)).toBe("CANCELLED");
    expect(await skuStock()).toEqual({ stock: INITIAL_STOCK, locked: 0 });
  });

  it("★ 幂等：同一任务重入两次不会重复释放库存，且第二次不抛错", async () => {
    const placed = await placeOrder("seam-consume-2");
    expect(placed.status).toBe(200);
    const orderNo = placed.orderNo as string;
    const orderId = await orderIdOf(orderNo);

    d1.run(
      `UPDATE orders SET pay_deadline = ? WHERE id = ?`,
      new Date(Date.now() - 60_000).toISOString(),
      orderId,
    );
    const envelope = await latestTimeoutEnvelope();
    await executeTaskEnvelope(d1.database, envelope);
    expect(await skuStock()).toEqual({ stock: INITIAL_STOCK, locked: 0 });
    expect(await orderStatus(orderNo)).toBe("CANCELLED");

    // 第二次执行：订单已是 CANCELLED，必须**不抛错**且不再动库存。
    await expect(executeTaskEnvelope(d1.database, envelope)).resolves.toEqual({ handled: true });
    expect(await skuStock()).toEqual({ stock: INITIAL_STOCK, locked: 0 });
    expect(await cancelledLogCount(orderId)).toBe(1);
  });

  it("已支付订单：任务**直接返回不报错**（不误关已付款的单）", async () => {
    const placed = await placeOrder("seam-consume-3");
    expect(placed.status).toBe(200);
    const orderNo = placed.orderNo as string;
    const envelope = await latestTimeoutEnvelope();

    // 模拟支付回调把订单置为已支付。
    d1.run(`UPDATE orders SET status = 'PAID' WHERE order_no = ?`, orderNo);

    await expect(executeTaskEnvelope(d1.database, envelope)).resolves.toEqual({ handled: true });

    // 已支付的单**不能**被关掉，锁定库存也不能被释放（钱已收，货要发）。
    expect(await orderStatus(orderNo)).toBe("PAID");
    expect(await skuStock()).toEqual({ stock: INITIAL_STOCK, locked: CART_QUANTITY });
  });

  it("未注册的任务类型：返回 `{ handled: false }`（调用方据此 ack + 告警，而非无限重投）", async () => {
    const outcome = await executeTaskEnvelope(d1.database, {
      type: "unknown.task.type" as never,
      payload: {},
    });
    expect(outcome).toEqual({ handled: false });
  });
});

/* -------------------------------------------------------------------------- */
/* Queues 出口 `queue()`（`apps/api/src/jobs/index.ts`）                        */
/* -------------------------------------------------------------------------- */

/** `queue()` 的假 `MessageBatch`（显式满足 workers-types 的形状，**不用 `any`**）。 */
interface QueueBatchProbe {
  readonly batch: MessageBatch<TaskEnvelope>;
  readonly acked: string[];
  readonly retried: { readonly id: string; readonly delaySeconds: number | undefined }[];
}

function makeQueueBatch(bodies: readonly TaskEnvelope[]): QueueBatchProbe {
  const acked: string[] = [];
  const retried: { id: string; delaySeconds: number | undefined }[] = [];

  const messages: Message<TaskEnvelope>[] = bodies.map((body, index) => {
    const id = `msg-${index + 1}`;
    return {
      id,
      timestamp: new Date(),
      body,
      attempts: 1,
      retry: (options?: QueueRetryOptions): void => {
        retried.push({ id, delaySeconds: options?.delaySeconds });
      },
      ack: (): void => {
        acked.push(id);
      },
    };
  });

  const batch: MessageBatch<TaskEnvelope> = {
    messages,
    queue: "dshop-tasks",
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    retryAll: (): void => undefined,
    ackAll: (): void => undefined,
  };

  return { batch, acked, retried };
}

/** 假 `ExecutionContext`（`queue()` 不使用它，只需形状满足）。 */
const fakeCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

/** 任何 D1 访问都抛错的坏库：用来走 `queue()` 的「handler 抛错」分支。 */
const throwingDb = {
  prepare: (): never => {
    throw new Error("db unavailable");
  },
} as unknown as D1Database;

describe("S1 升级缝：Queues 出口 `queue()`（`docs/12` §12.9.3）", () => {
  it("已注册类型 + handler 成功 → `ack()`（不 retry）", async () => {
    const placed = await placeOrder("seam-queue-ack");
    const orderNo = placed.orderNo as string;
    const orderId = await orderIdOf(orderNo);
    d1.run(
      `UPDATE orders SET pay_deadline = ? WHERE id = ?`,
      new Date(Date.now() - 60_000).toISOString(),
      orderId,
    );

    const envelope = await latestTimeoutEnvelope();
    const probe = makeQueueBatch([envelope]);

    await queue(probe.batch, createEnv(), fakeCtx);

    expect(probe.acked).toEqual(["msg-1"]);
    expect(probe.retried).toEqual([]);
    expect(await orderStatus(orderNo)).toBe("CANCELLED");
  });

  it("handler 抛错 → `retry()`（不 ack，交给 Queues 退避重试）", async () => {
    // 先造一条真实消息（`queue()` 只吃 `MessageBatch`，payload 必须可解析）。
    await placeOrder("seam-queue-retry");
    const envelope = await latestTimeoutEnvelope();
    const probe = makeQueueBatch([envelope]);

    await queue(probe.batch, createEnv({ DB: throwingDb }), fakeCtx);

    expect(probe.acked).toEqual([]);
    expect(probe.retried).toHaveLength(1);
    expect(probe.retried[0]?.id).toBe("msg-1");
  });

  it("未注册类型 → `ack()` + 告警（retry 会无限重投本版本不认识的消息）", async () => {
    const probe = makeQueueBatch([{ type: "unknown.task.type" as never, payload: {} }]);

    await queue(probe.batch, createEnv(), fakeCtx);

    expect(probe.acked).toEqual(["msg-1"]);
    expect(probe.retried).toEqual([]);
  });

  it("★ 未到期（`deferredUntilMs` 在未来）→ `retry({ delaySeconds })`，**不 ack**", async () => {
    const placed = await placeOrder("seam-queue-defer");
    const orderNo = placed.orderNo as string;
    const rows = await timeoutTaskRows();
    bypassTransportDelay(rows[0]?.id as string);

    const envelope = await latestTimeoutEnvelope();
    const probe = makeQueueBatch([envelope]);

    await queue(probe.batch, createEnv(), fakeCtx);

    // 消息不能丢：既不能 ack，也不能原样立刻重投——必须带剩余延迟。
    expect(probe.acked).toEqual([]);
    expect(probe.retried).toHaveLength(1);
    expect(probe.retried[0]?.delaySeconds).toBeGreaterThan(0);
    expect(await orderStatus(orderNo)).toBe("PENDING_PAYMENT");
  });
});
