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
import {
  TASK_MAX_ATTEMPTS as TASK_MAX_ATTEMPTS_JOBS,
  claimPendingTask,
  consumeTaskQueue,
  executeTaskEnvelope,
} from "../src/jobs/task-queue.js";
import { TASK_MAX_ATTEMPTS as TASK_MAX_ATTEMPTS_SERVICES } from "@dshop/services";
import {
  cancelUnpaidOrder,
  findOrderStatusById,
  listOrderSkuQuantities,
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

  it("★ P0-1 传输层延迟：`run_at` 不早于 `pay_deadline`（语义断言，不再用 ≤1s 容差）", async () => {
    const placed = await placeOrder("seam-delay-1");
    const orderNo = placed.orderNo as string;

    const payDeadline = await orderPayDeadline(orderNo);
    expect(payDeadline).toBeDefined();

    const rows = await timeoutTaskRows();
    const runAt = rows[0]?.run_at ?? "";
    // 修复前：`run_at` 写死为 now → 任务在下单后 1 分钟内就被 Cron 消费并关单。
    //
    // ★ P2#5：旧断言是「差值 ≤ 1000ms」，把**实现细节**（`delaySeconds` 用
    // `Math.ceil` 整秒舍入）当成了不变量——真机 D1 往返 > 1s 时它必然 flake。
    // 改成**语义断言**：`run_at` 是「最早可运行时刻」，它只需
    //   ① 不早于 `pay_deadline`（否则任务会在期限前被消费，退回 P0-1）；
    //   ② 不晚得太离谱（宽松上界 60s，只抓「算错了一个量级」这类真缺陷）。
    const runAtMs = Date.parse(runAt);
    const payDeadlineMs = Date.parse(payDeadline ?? "");
    expect(runAtMs).toBeGreaterThanOrEqual(payDeadlineMs);
    expect(runAtMs - payDeadlineMs).toBeLessThan(60_000);
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

    expect(cancelled.migrated).toBe(false);
    expect(cancelled.released).toBe(0);
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

describe("S1 升级缝：Cron 重叠时的抢占守卫（复核遗留项）", () => {
  it("★ 已置 `processing` 的行不会被再次抢占 —— 重叠 Cron 不会并行执行同一任务", async () => {
    const placed = await placeOrder("seam-claim-guard");
    const orderNo = placed.orderNo as string;
    const rows = await timeoutTaskRows();
    const taskId = rows[0]?.id as string;
    // 让任务立刻可消费，并模拟「另一个 Cron tick 已把它抢走」。
    bypassTransportDelay(taskId);
    expect(await claimPendingTask(d1.database, taskId, new Date().toISOString())).toBe(true);
    expect(await claimPendingTask(d1.database, taskId, new Date().toISOString())).toBe(false);

    // 第二次抢占失败后，消费端必须**跳过**它：订单不能被这个 tick 关掉。
    const result = await consumeTaskQueue(d1.database, Date.now());
    expect(result.succeeded).toBe(0);
    expect(await orderStatus(orderNo)).toBe("PENDING_PAYMENT");

    // 行仍是 `processing`（不是 `pending`），说明没被重复执行。
    const after = await d1.query<{ status: string }>(
      `SELECT status FROM task_queue WHERE id = ?`,
      taskId,
    );
    expect(after[0]?.status).toBe("processing");
  });
});

/* -------------------------------------------------------------------------- */
/* P1-A：同毫秒二次关单不二次释放锁定                                             */
/* -------------------------------------------------------------------------- */

/** 重新播种一行购物车（下单会清空购物车，造第二笔单前必须补回来）。 */
function reseedCartItem(id: string): void {
  d1.run(
    `INSERT INTO cart_items (id, user_id, sku_id, quantity, selected, created_at, updated_at)
     VALUES (?, ?, ?, ${CART_QUANTITY}, 1, ?, ?)`,
    id,
    USER_ID,
    SKU_ID,
    NOW,
    NOW,
  );
}

/** 直接向 `task_queue` 插入一条已注册类型的行（构造边界 payload 用）。 */
function insertTimeoutTaskRow(id: string, payload: string, runAtIso: string): void {
  d1.run(
    `INSERT INTO task_queue
       (id, type, payload, status, attempts, run_at, last_error, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', 0, ?, NULL, ?, ?)`,
    id,
    TASK_TYPE.ORDER_TIMEOUT_CANCEL,
    payload,
    runAtIso,
    runAtIso,
    runAtIso,
  );
}

/** 读 `task_queue` 某行的状态 / attempts / run_at / last_error。 */
async function taskRowState(
  id: string,
): Promise<{ status: string; attempts: number; run_at: string; last_error: string | null }> {
  const rows = await d1.query<{
    status: string;
    attempts: number;
    run_at: string;
    last_error: string | null;
  }>(`SELECT status, attempts, run_at, last_error FROM task_queue WHERE id = ?`, id);
  const row = rows[0];
  if (row === undefined) throw new Error(`未找到 task_queue 行 ${id}`);
  return row;
}

describe("P1-A：同毫秒二次关单不得二次释放别人的锁定", () => {
  it("★ 同一 `nowIso` 调用 `cancelUnpaidOrder` 两次 → 第二次 `false`，锁定只减第一笔的量", async () => {
    // 两笔单都锁同一个 SKU：locked_stock 初值 = 2 × CART_QUANTITY。
    const first = await placeOrder("seam-p1a-1");
    expect(first.status).toBe(200);
    reseedCartItem("01J9Z8K2M4N5P6Q7R8S9T0CC02");
    const second = await placeOrder("seam-p1a-2");
    expect(second.status).toBe(200);

    const orderId1 = await orderIdOf(first.orderNo as string);
    const orderId2 = await orderIdOf(second.orderNo as string);
    expect(await skuStock()).toEqual({
      stock: INITIAL_STOCK,
      locked: CART_QUANTITY * 2,
    });

    const items = await listOrderSkuQuantities(d1.database, orderId1);
    const skuQuantities = items.map((item) => ({
      skuId: item.sku_id,
      quantity: item.quantity,
    }));

    // ★ **同一个 `nowIso`**：模拟重叠 Cron / Queues 与 Cron 并发 / 同毫秒手工重放。
    const nowIso = new Date().toISOString();
    const cancelledFirst = await cancelUnpaidOrder(d1.database, {
      orderId: orderId1,
      nowIso,
      skuQuantities,
    });
    expect(cancelledFirst.migrated).toBe(true);
    expect(cancelledFirst.released).toBe(1);

    const cancelledSecond = await cancelUnpaidOrder(d1.database, {
      orderId: orderId1,
      nowIso,
      skuQuantities,
    });
    // ★ 核心：第二次**必须** `false`（旧实现用 `cancelled_at = nowIso` 守卫，
    //   同毫秒相等 → EXISTS 为真 → 再释放一遍别人的锁）。
    expect(cancelledSecond.migrated).toBe(false);
    // ★ 第二次**一条释放都不能生效**（旧实现会在这里把别人的锁也放掉）。
    expect(cancelledSecond.released).toBe(0);

    // ★ 钱货对应关系不能被弄坏：只剩第二笔单的锁定，第一笔的 2 件被释放。
    expect(await skuStock()).toEqual({ stock: INITIAL_STOCK, locked: CART_QUANTITY });
    // 关单日志恒 1 行（不是 2 行）。
    expect(await cancelledLogCount(orderId1)).toBe(1);
    // 第二笔单完全没被波及。
    expect(await orderStatus(second.orderNo as string)).toBe("PENDING_PAYMENT");
    expect(await cancelledLogCount(orderId2)).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* P1-B：支付期限 NULL / 非法串 / 完全不可解析                                     */
/* -------------------------------------------------------------------------- */

describe("P1-B：`pay_deadline` 不可用时的兜底与「绝不静默关单」", () => {
  it("★ `pay_deadline` 为 `NULL` + `createdAtMs` 合法未超时 → 不关单、`deferred === 1`", async () => {
    const placed = await placeOrder("seam-p1b-null");
    const orderNo = placed.orderNo as string;
    const orderId = await orderIdOf(orderNo);
    const rows = await timeoutTaskRows();
    const taskId = rows[0]?.id as string;
    const payload = JSON.parse(rows[0]?.payload ?? "{}") as { createdAtMs: number };

    d1.run(`UPDATE orders SET pay_deadline = NULL WHERE id = ?`, orderId);
    bypassTransportDelay(taskId);

    const result = await consumeTaskQueue(d1.database, Date.now());

    // ★ 绝不关单（旧实现：`Number.isFinite(NaN) === false` → 跳过延后 → 立刻关单）。
    expect(await orderStatus(orderNo)).toBe("PENDING_PAYMENT");
    expect(await skuStock()).toEqual({ stock: INITIAL_STOCK, locked: CART_QUANTITY });
    expect(result.deferred).toBe(1);
    expect(result.succeeded).toBe(0);
    // 兜底期限 = `createdAtMs + ORDER_PAY_TIMEOUT_MINUTES`（15 分钟）。
    const after = await taskRowState(taskId);
    expect(after.status).toBe("pending");
    expect(Date.parse(after.run_at)).toBe(payload.createdAtMs + 15 * 60_000);
  });

  it("★ `pay_deadline` 为非法串 → 走 `createdAtMs` 兜底延后，不关单", async () => {
    const placed = await placeOrder("seam-p1b-bad");
    const orderNo = placed.orderNo as string;
    const orderId = await orderIdOf(orderNo);
    const rows = await timeoutTaskRows();
    const taskId = rows[0]?.id as string;
    const payload = JSON.parse(rows[0]?.payload ?? "{}") as { createdAtMs: number };

    d1.run(`UPDATE orders SET pay_deadline = 'not-a-date' WHERE id = ?`, orderId);
    bypassTransportDelay(taskId);

    const result = await consumeTaskQueue(d1.database, Date.now());

    expect(await orderStatus(orderNo)).toBe("PENDING_PAYMENT");
    expect(result.deferred).toBe(1);
    expect(result.succeeded).toBe(0);
    const after = await taskRowState(taskId);
    expect(after.status).toBe("pending");
    expect(Date.parse(after.run_at)).toBe(payload.createdAtMs + 15 * 60_000);
  });

  it("★ `pay_deadline` 与 `createdAtMs` 都不可用 → 不关单，任务置 `failed`（`failed === 1`）", async () => {
    const placed = await placeOrder("seam-p1b-none");
    const orderNo = placed.orderNo as string;
    const orderId = await orderIdOf(orderNo);

    d1.run(`UPDATE orders SET pay_deadline = NULL WHERE id = ?`, orderId);
    // `1e999` 经 `JSON.parse` 得到 `Infinity`：`typeof === "number"` 能通过
    // `parseTimeoutPayload`，但 `Number.isFinite` 为假 → 两处兜底都不可用。
    // ⚠️ 必须**手写** payload 串：`JSON.stringify({ createdAtMs: Infinity })` 会输出
    // `null`（JSON 无 Infinity 字面量），那样测的就不是本分支了。
    const past = new Date(Date.now() - 60_000).toISOString();
    insertTimeoutTaskRow(
      "01J9Z8K2M4N5P6Q7R8S9T0PF01",
      `{"orderId":"${orderId}","orderNo":"${orderNo}","createdAtMs":1e999}`,
      past,
    );
    // 把生产者那条真任务挪走，避免干扰计数。
    d1.run(
      `DELETE FROM task_queue WHERE type = ? AND id != ?`,
      TASK_TYPE.ORDER_TIMEOUT_CANCEL,
      "01J9Z8K2M4N5P6Q7R8S9T0PF01",
    );

    const result = await consumeTaskQueue(d1.database, Date.now());

    // ★ 绝不把「未知期限」当「已过期」。
    expect(await orderStatus(orderNo)).toBe("PENDING_PAYMENT");
    expect(await skuStock()).toEqual({ stock: INITIAL_STOCK, locked: CART_QUANTITY });
    const after = await taskRowState("01J9Z8K2M4N5P6Q7R8S9T0PF01");
    expect(after.status).toBe("failed");
    expect(after.last_error).toBe("task_pay_deadline_unresolvable");
    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(result.deferred).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* P2：常量一致性 / 退避 / 坏 payload / processing 超时自愈                        */
/* -------------------------------------------------------------------------- */

describe("P2：任务队列的常量、退避与自愈", () => {
  it("★ P2#1：jobs 层与 services 层的最大尝试次数是**同一个来源**（无重复常量可漂移）", () => {
    // jobs 层现在是 `export { TASK_MAX_ATTEMPTS }` 的再导出（不再是独立的 `= 5`），
    // 故这个断言同时锁住「值相等」与「单一来源」。
    expect(TASK_MAX_ATTEMPTS_JOBS).toBe(TASK_MAX_ATTEMPTS_SERVICES);
    expect(TASK_MAX_ATTEMPTS_JOBS).toBe(5);
  });

  it("★ P2#2：失败重试**推进 `run_at`**（有界退避，而非每分钟硬重试）", async () => {
    const placed = await placeOrder("seam-p2-backoff");
    const orderNo = placed.orderNo as string;
    const orderId = await orderIdOf(orderNo);
    const rows = await timeoutTaskRows();
    const taskId = rows[0]?.id as string;

    d1.run(
      `UPDATE orders SET pay_deadline = ? WHERE id = ?`,
      new Date(Date.now() - 60_000).toISOString(),
      orderId,
    );
    bypassTransportDelay(taskId);

    // 用真实 SQLite 触发器让关单写入**必然抛错**（模拟 D1 抖动），
    // 从而走 `consumeTaskQueue` 的失败分支。
    d1.run(
      `CREATE TRIGGER fail_cancel BEFORE UPDATE ON orders
         WHEN NEW.status = 'CANCELLED'
         BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    );
    try {
      const nowMs = Date.now();
      const result = await consumeTaskQueue(d1.database, nowMs);
      expect(result.failed).toBe(1);
      expect(result.succeeded).toBe(0);

      const after = await taskRowState(taskId);
      expect(after.status).toBe("pending");
      expect(after.attempts).toBe(1);
      expect(after.last_error).toBe("boom");
      // ★ 核心：`run_at` 被推到**未来**（attempts=1 → 60s 退避）。
      expect(Date.parse(after.run_at)).toBeGreaterThan(nowMs);
    } finally {
      d1.run(`DROP TRIGGER fail_cancel`);
    }
  });

  it("★ P2#3：坏 payload 置 `failed`（不再当成功静默丢弃）", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    insertTimeoutTaskRow("01J9Z8K2M4N5P6Q7R8S9T0PB01", "not-json", past);

    const result = await consumeTaskQueue(d1.database, Date.now());

    const after = await taskRowState("01J9Z8K2M4N5P6Q7R8S9T0PB01");
    expect(after.status).toBe("failed");
    expect(after.last_error).toBe("task_payload_invalid");
    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(0);
  });

  it("★ P2#6：超时 `processing` 行被回收并**重新执行**（不是永久卡住）", async () => {
    const placed = await placeOrder("seam-p2-requeue");
    const orderNo = placed.orderNo as string;
    const orderId = await orderIdOf(orderNo);
    const rows = await timeoutTaskRows();
    const taskId = rows[0]?.id as string;

    d1.run(
      `UPDATE orders SET pay_deadline = ? WHERE id = ?`,
      new Date(Date.now() - 60_000).toISOString(),
      orderId,
    );
    // 手工把它置成「崩溃遗留」：`processing` 且 `updated_at` 是 1 小时前
    // （远超 `TASK_QUEUE_PROCESSING_TIMEOUT_MS = 5 分钟`）。
    // ⚠️ 同时把 `run_at` 推到过去：真实场景里它**正是**因为 `run_at <= now`
    // 才被抢占成 `processing`（否则回收后也仍不满足可运行谓词）。
    const longAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    bypassTransportDelay(taskId);
    d1.run(
      `UPDATE task_queue SET status = 'processing', updated_at = ? WHERE id = ?`,
      longAgo,
      taskId,
    );

    const result = await consumeTaskQueue(d1.database, Date.now());

    expect(result.requeued).toBe(1);
    // ★ 被**重新执行**：订单真的被关掉（不是停在 processing 永不前进）。
    expect(await orderStatus(orderNo)).toBe("CANCELLED");
    expect(result.succeeded).toBe(1);
    expect((await taskRowState(taskId)).status).toBe("done");
    expect((await taskRowState(taskId)).status).toBe("done");
  });

  it("★ 毒任务不会无限回收：回收会累加 `attempts`，达上限后进死信（复核 P1#7）", async () => {
    // 真实场景：isolate 被回收 → handler 从未返回、`catch` 从未进入 → `attempts` 永远 0
    // → 旧实现下「每 5 分钟回收一次」会**永远**重试，`deadLetterExhaustedTasks` 永不触发。
    const placed = await placeOrder("seam-p2-poison");
    const orderNo = placed.orderNo as string;
    const rows = await timeoutTaskRows();
    const taskId = rows[0]?.id as string;
    bypassTransportDelay(taskId);

    const longAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    const attempted: number[] = [];
    // 反复制造「崩溃遗留」并回收，直到它被判定为死信。
    for (let i = 0; i < 10; i += 1) {
      const state = await taskRowState(taskId);
      attempted.push(state.attempts);
      if (state.status === "failed") break;
      d1.run(
        `UPDATE task_queue SET status = 'processing', updated_at = ? WHERE id = ?`,
        longAgo,
        taskId,
      );
      await consumeTaskQueue(d1.database, Date.now());
    }

    // ★ 关键断言：`attempts` **确实在增长**（旧实现恒为 0），最终进入死信。
    expect(attempted[attempted.length - 1]).toBeGreaterThan(attempted[0] ?? 0);
    expect((await taskRowState(taskId)).status).toBe("failed");
    // 订单未被错关（该订单的 pay_deadline 仍未来 → 每次都走延后，与死信无关）。
    expect(await orderStatus(orderNo)).toBe("PENDING_PAYMENT");
  });
});

/* -------------------------------------------------------------------------- */
/* P1-B：Queues 出口对「不可重试失败」的处理                                      */
/* -------------------------------------------------------------------------- */

describe("P1-B：Queues 出口的不可重试失败 → ack + 告警", () => {
  it("★ 坏 payload → `ack()`（不 retry：重投只会重复失败）", async () => {
    const probe = makeQueueBatch([
      {
        type: TASK_TYPE.ORDER_TIMEOUT_CANCEL,
        payload: { orderId: "", orderNo: "", createdAtMs: 1 },
      },
    ]);

    await queue(probe.batch, createEnv(), fakeCtx);

    expect(probe.acked).toEqual(["msg-1"]);
    expect(probe.retried).toEqual([]);
  });
});
