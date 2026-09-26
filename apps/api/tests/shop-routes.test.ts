/**
 * `/api/v1/shop/*` 契约测试（`docs/06` §6、`docs/09` §9.1、`docs/05` §5.3）。
 *
 * ## 策略
 *
 * - **内存 fake D1**：真实落库（INSERT/UPDATE 会改内存数组），
 *   否则无法验证幂等、库存锁定与归属隔离。
 * - **自建测试 app**：显式 `app.route("/api/v1/shop", shopRoutes)`。
 *   `apps/api/src/index.ts` 的挂载由主入口负责（本任务的文件所有权约束不允许改它）。
 * - **不 import `../src/index.js`**：主入口在并行改造中（还会挂 merchant 等组），
 *   其中任一模块编译失败都会让本文件**整体无法收集**。负向控制改为挂
 *   **真实的** `agentRoutes`，同样锁定「Agent 组仍是整数码」这条契约。
 * - `ENVIRONMENT: "development"` → 短信验证码固定为 `123456`（见 `routes/shop/auth.ts`
 *   的 `generateSmsCode`），使登录链路可测而不依赖日志。
 */

import { encryptPii, signJwt } from "@dshop/auth";
import {
  IDEMPOTENCY_KEY_HEADER,
  JWT_AUDIENCE,
  SHOP_ENDPOINT_LIST,
  backofficeErrorCodesForPath,
} from "@dshop/shared";
import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Env } from "../src/env.js";
import type { AppEnv } from "../src/lib/context.js";
import { backofficeErrorResponse } from "../src/lib/errors.js";
import { agentRoutes } from "../src/routes/agent/index.js";
import { shopRoutes } from "../src/routes/shop/index.js";

/* -------------------------------------------------------------------------- */
/* 固定数据                                                                     */
/* -------------------------------------------------------------------------- */

const JWT_SECRET = "shop-test-jwt-secret";
const PHONE_HASH_PEPPER = "shop-test-pepper";
const PHONE_ENC_KEY = "shop-test-phone-key";

const USER_A_ID = "01J9Z8K2M4N5P6Q7R8S9T0A001";
const USER_B_ID = "01J9Z8K2M4N5P6Q7R8S9T0B001";
const PHONE_A = "13800138000";
const ADDRESS_A_ID = "01J9Z8K2M4N5P6Q7R8S9T0AD01";
const MERCHANT_ID = "01J9Z8K2M4N5P6Q7R8S9T0M001";
const STORE_ID = "01J9Z8K2M4N5P6Q7R8S9T0S001";
const SPU_ID = "01J9Z8K2M4N5P6Q7R8S9T0P001";
const SKU_OK_ID = "01J9Z8K2M4N5P6Q7R8S9T0K001";
const SKU_LOW_ID = "01J9Z8K2M4N5P6Q7R8S9T0K002";
const CART_OK_ID = "01J9Z8K2M4N5P6Q7R8S9T0C001";
const CART_LOW_ID = "01J9Z8K2M4N5P6Q7R8S9T0C002";
/** 用户 B 的订单号（用于归属隔离用例）。 */
const ORDER_B_NO = "DS20260920143000999";
/** 用户 B 的售后单号。 */
const AFTERSALE_B_NO = "AS20260920099";

/** 固定验证码（`ENVIRONMENT: "development"` 时的实现侧定案值）。 */
const DEV_SMS_CODE = "123456";

type Row = Record<string, unknown>;

/* -------------------------------------------------------------------------- */
/* 内存 D1 fake                                                                 */
/* -------------------------------------------------------------------------- */

const users: Row[] = [];
const addresses: Row[] = [];
const settings: Row[] = [];
const categories: Row[] = [];
const products: Row[] = [];
const skus: Row[] = [];
const attrs: Row[] = [];
const merchants: Row[] = [];
const stores: Row[] = [];
const cartItems: Row[] = [];
const orders: Row[] = [];
const subOrders: Row[] = [];
const orderItems: Row[] = [];
const orderStatusLogs: Row[] = [];
const aftersales: Row[] = [];
const aftersaleLogs: Row[] = [];
const payments: Row[] = [];
const idempotencyKeys: Row[] = [];

/** 播种：一次请求前重置全部表。 */
function seed(): void {
  users.length = 0;
  addresses.length = 0;
  settings.length = 0;
  categories.length = 0;
  products.length = 0;
  skus.length = 0;
  attrs.length = 0;
  merchants.length = 0;
  stores.length = 0;
  cartItems.length = 0;
  orders.length = 0;
  subOrders.length = 0;
  orderItems.length = 0;
  orderStatusLogs.length = 0;
  aftersales.length = 0;
  aftersaleLogs.length = 0;
  payments.length = 0;
  idempotencyKeys.length = 0;

  // 手机号列存**明文**：`decryptPii()` 对非密文封装返回 `null`，
  // 仓储层据此回退为原文（见 `shop-users.ts` 的 `decryptUserPhone`），
  // 故测试无需构造真实 AES 密文即可覆盖解密分支。
  users.push({
    id: USER_A_ID,
    phone: PHONE_A,
    phone_hash: "hash-a",
    nickname: "测试用户A",
    avatar_url: null,
    status: "active",
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
  });
  users.push({
    id: USER_B_ID,
    phone: "13900139000",
    phone_hash: "hash-b",
    nickname: "测试用户B",
    avatar_url: null,
    status: "active",
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
  });

  addresses.push({
    id: ADDRESS_A_ID,
    user_id: USER_A_ID,
    receiver_name: "张三",
    receiver_phone: "13800138000",
    province: "浙江省",
    city: "杭州市",
    district: "西湖区",
    detail: "文三路 478 号",
    postal_code: "310012",
    is_default: 1,
    status: "active",
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
  });

  categories.push({
    id: "01J9Z8K2M4N5P6Q7R8S9T0G001",
    parent_id: null,
    name: "数码",
    slug: "digital",
    sort_order: 0,
    status: "active",
  });

  products.push({
    id: SPU_ID,
    merchant_id: MERCHANT_ID,
    category_id: "01J9Z8K2M4N5P6Q7R8S9T0G001",
    category_path: '["数码"]',
    title: "极光 Pro 真无线降噪耳机",
    subtitle: "IPX5 防水",
    main_image: "https://example.test/a.png",
    detail_html: "<p>详情</p>",
    brand: "DShop",
    status: "onsale",
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
  });

  // SKU_OK 库存充足；SKU_LOW 库存不足（用于负向控制）
  skus.push({
    id: SKU_OK_ID,
    product_id: SPU_ID,
    spec: '{"颜色":"曜石黑"}',
    sku_code: "SKU-OK",
    price: 25800,
    market_price: 29900,
    stock: 100,
    locked_stock: 0,
    restock_eta: null,
    status: "active",
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
  });
  skus.push({
    id: SKU_LOW_ID,
    product_id: SPU_ID,
    spec: '{"颜色":"珍珠白"}',
    sku_code: "SKU-LOW",
    price: 9900,
    market_price: null,
    stock: 1,
    locked_stock: 0,
    restock_eta: null,
    status: "active",
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
  });

  attrs.push({
    id: "01J9Z8K2M4N5P6Q7R8S9T0AT01",
    spu_id: SPU_ID,
    group_name: "基本参数",
    attr_name: "防护等级",
    attr_value: "IPX5",
    unit: null,
    sort_order: 0,
    searchable: 1,
  });

  merchants.push({ id: MERCHANT_ID, name: "DShop 自营旗舰店", type: "self" });
  stores.push({
    id: STORE_ID,
    merchant_id: MERCHANT_ID,
    name: "杭州仓",
    type: "warehouse",
    province: "浙江省",
    city: "杭州市",
    district: "西湖区",
    supports_pickup: 0,
    status: "active",
  });

  // 用户 B 的订单 + 售后（归属隔离用例的目标）
  orders.push({
    id: "01J9Z8K2M4N5P6Q7R8S9T0WB01",
    order_no: ORDER_B_NO,
    user_id: USER_B_ID,
    status: "PAID",
    total_amount: 100,
    discount_amount: 0,
    freight_amount: 0,
    pay_amount: 100,
    address_snapshot: JSON.stringify({ receiver_name: "李四", receiver_phone: "13900139000" }),
    coupon_id: null,
    channel: "web",
    pay_deadline: null,
    paid_at: "2026-09-20T07:00:00.000Z",
    completed_at: null,
    cancelled_at: null,
    remark: null,
    created_at: "2026-09-20T06:30:00.000Z",
    updated_at: "2026-09-20T07:00:00.000Z",
  });
  subOrders.push({
    id: "01J9Z8K2M4N5P6Q7R8S9T0WS01",
    sub_order_no: `${ORDER_B_NO}-01`,
    order_id: "01J9Z8K2M4N5P6Q7R8S9T0WB01",
    merchant_id: MERCHANT_ID,
    store_id: STORE_ID,
    status: "PAID",
    subtotal: 100,
    discount_alloc: 0,
    freight: 0,
    commission_amount: 0,
    express_company: null,
    express_company_code: null,
    express_no: null,
    shipped_at: null,
    received_at: null,
    settled: 0,
    created_at: "2026-09-20T06:30:00.000Z",
    updated_at: "2026-09-20T06:30:00.000Z",
  });
  orderItems.push({
    id: "01J9Z8K2M4N5P6Q7R8S9T0WI01",
    sub_order_id: "01J9Z8K2M4N5P6Q7R8S9T0WS01",
    order_id: "01J9Z8K2M4N5P6Q7R8S9T0WB01",
    spu_id: SPU_ID,
    sku_id: SKU_OK_ID,
    title: "极光 Pro 真无线降噪耳机",
    image: null,
    spec: '{"颜色":"曜石黑"}',
    unit_price: 100,
    quantity: 1,
    subtotal: 100,
    created_at: "2026-09-20T06:30:00.000Z",
  });

  aftersales.push({
    id: "01J9Z8K2M4N5P6Q7R8S9T0WA01",
    aftersale_no: AFTERSALE_B_NO,
    order_id: "01J9Z8K2M4N5P6Q7R8S9T0WB01",
    sub_order_id: "01J9Z8K2M4N5P6Q7R8S9T0WS01",
    user_id: USER_B_ID,
    sku_id: SKU_OK_ID,
    item_title: "极光 Pro 真无线降噪耳机",
    quantity: 1,
    type: "refund_only",
    status: "PENDING_MERCHANT",
    reason: "不想要了",
    evidence_urls: "[]",
    refund_amount: 100,
    return_address: null,
    return_express_company: null,
    return_express_no: null,
    deadline_at: null,
    applied_at: "2026-09-21T00:00:00.000Z",
    refunded_at: null,
    created_at: "2026-09-21T00:00:00.000Z",
    updated_at: "2026-09-21T00:00:00.000Z",
  });
  aftersaleLogs.push({
    id: "01J9Z8K2M4N5P6Q7R8S9T0WA01-L0",
    aftersale_id: "01J9Z8K2M4N5P6Q7R8S9T0WA01",
    from_status: null,
    to_status: "PENDING_MERCHANT",
    actor_type: "buyer",
    actor_id: USER_B_ID,
    remark: null,
    occurred_at: "2026-09-21T00:00:00.000Z",
    created_at: "2026-09-21T00:00:00.000Z",
  });
}

/** 把用户 A 的购物车置为「可下单」（1 件库存充足 SKU）。 */
function seedCartOk(): void {
  cartItems.push({
    id: CART_OK_ID,
    user_id: USER_A_ID,
    sku_id: SKU_OK_ID,
    quantity: 1,
    selected: 1,
    created_at: "2026-09-20T00:00:00.000Z",
    updated_at: "2026-09-20T00:00:00.000Z",
  });
}

/** 把用户 A 的购物车置为「库存不足」（需求 5 > 可售 1）。 */
function seedCartLowStock(): void {
  cartItems.push({
    id: CART_LOW_ID,
    user_id: USER_A_ID,
    sku_id: SKU_LOW_ID,
    quantity: 5,
    selected: 1,
    created_at: "2026-09-20T00:00:00.000Z",
    updated_at: "2026-09-20T00:00:00.000Z",
  });
}

/** 购物车行（带 SKU / 商品关联列）的组装（模拟 `LEFT JOIN`）。 */
function joinedCartRows(userId: string, itemIds?: readonly string[]): Row[] {
  return cartItems
    .filter((row) => itemIds === undefined || itemIds.includes(String(row.id)))
    .map((row) => {
      const sku = skus.find((s) => s.id === row.sku_id);
      const product = sku === undefined ? undefined : products.find((p) => p.id === sku.product_id);
      return {
        id: row.id,
        sku_id: row.sku_id,
        quantity: row.quantity,
        created_at: row.created_at,
        sku_code: sku?.sku_code ?? null,
        spec: sku?.spec ?? null,
        price: sku?.price ?? null,
        stock: sku?.stock ?? null,
        locked_stock: sku?.locked_stock ?? null,
        sku_status: sku?.status ?? null,
        product_id: sku?.product_id ?? null,
        title: product?.title ?? null,
        product_status: product?.status ?? null,
        merchant_id: product?.merchant_id ?? null,
      };
    });
}

/** SQL 分发结果。 */
interface QueryResult {
  readonly rows: Row[];
  readonly changes: number;
}

/** 生成 `?, ?, ...` 计数（占位符个数）。 */
function countPlaceholders(sql: string): number {
  return (sql.match(/\?/g) ?? []).length;
}

/**
 * 按 SQL 模式分发。
 *
 * ⚠️ 刻意**不做完整 SQL 引擎**：只覆盖 shop 路由实际发出的查询形态，
 * 与 `agent-contract.test.ts` / `admin-auth.test.ts` 同思路。
 */
function dispatch(sql: string, args: readonly unknown[]): QueryResult {
  const str = (v: unknown): string => String(v ?? "");
  const num = (v: unknown): number => Number(v ?? 0);

  /* ---- idempotency_keys ---- */
  if (sql.includes("INSERT INTO idempotency_keys")) {
    const [id, scope, key, requestHash, expiresAt, createdAt] = args;
    if (idempotencyKeys.some((r) => r.scope === scope && r.key === key)) {
      throw new Error("UNIQUE constraint failed: idempotency_keys.scope, idempotency_keys.key");
    }
    idempotencyKeys.push({
      id,
      scope,
      key,
      request_hash: requestHash,
      response_body: null,
      status: "processing",
      expires_at: expiresAt,
      created_at: createdAt,
    });
    return { rows: [], changes: 1 };
  }
  if (sql.includes("FROM idempotency_keys")) {
    return {
      rows: idempotencyKeys.filter((r) => r.scope === args[0] && r.key === args[1]),
      changes: 0,
    };
  }
  if (sql.includes("UPDATE idempotency_keys")) {
    const [responseBody, scope, key] = args;
    const row = idempotencyKeys.find((r) => r.scope === scope && r.key === key);
    if (row !== undefined) {
      row.response_body = responseBody;
      row.status = "completed";
      return { rows: [], changes: 1 };
    }
    return { rows: [], changes: 0 };
  }

  /* ---- settings（短信验证码暂存） ---- */
  if (sql.includes("INSERT INTO settings")) {
    const [key, value, description, updatedAt] = args;
    const row = settings.find((r) => r.key === key);
    if (row === undefined) {
      settings.push({ key, value, description, updated_at: updatedAt });
    } else {
      row.value = value;
      row.updated_at = updatedAt;
    }
    return { rows: [], changes: 1 };
  }
  if (sql.includes("DELETE FROM settings")) {
    const index = settings.findIndex((r) => r.key === args[0]);
    if (index === -1) return { rows: [], changes: 0 };
    settings.splice(index, 1);
    return { rows: [], changes: 1 };
  }
  if (sql.includes("FROM settings")) {
    return { rows: settings.filter((r) => r.key === args[0]), changes: 0 };
  }

  /* ---- users ---- */
  if (sql.includes("INSERT INTO users")) {
    const [id, phone, phoneHash, status, createdAt, updatedAt] = args;
    users.push({
      id,
      phone,
      phone_hash: phoneHash,
      nickname: null,
      avatar_url: null,
      status,
      created_at: createdAt,
      updated_at: updatedAt,
    });
    return { rows: [], changes: 1 };
  }
  if (sql.includes("FROM users") && sql.includes("phone_hash = ?")) {
    return { rows: users.filter((r) => r.phone_hash === args[0]), changes: 0 };
  }
  if (sql.includes("FROM users")) {
    return { rows: users.filter((r) => r.id === args[0]), changes: 0 };
  }

  /* ---- user_addresses ---- */
  if (sql.includes("FROM user_addresses") && sql.includes("WHERE id = ?")) {
    return {
      rows: addresses.filter(
        (r) => r.id === args[0] && r.user_id === args[1] && r.status === "active",
      ),
      changes: 0,
    };
  }
  if (sql.includes("FROM user_addresses")) {
    return {
      rows: addresses
        .filter((r) => r.user_id === args[0] && r.status === "active")
        .sort((a, b) => Number(b.is_default) - Number(a.is_default)),
      changes: 0,
    };
  }

  /* ---- categories ---- */
  if (sql.includes("FROM categories")) {
    return { rows: categories.filter((r) => r.status === "active"), changes: 0 };
  }

  /* ---- product_attrs ---- */
  if (sql.includes("FROM product_attrs")) {
    return { rows: attrs.filter((r) => r.spu_id === args[0]), changes: 0 };
  }

  /* ---- product_skus ---- */
  if (sql.includes("UPDATE product_skus")) {
    const skuId = str(args[1]);
    const quantity = num(args[2]);
    const row = skus.find((r) => r.id === skuId);
    if (row === undefined) return { rows: [], changes: 0 };
    if (sql.includes("locked_stock = locked_stock + ?")) {
      // 单语句原子锁定：判据在 WHERE 里（`docs/05` §5.3②）
      const available = num(row.stock) - num(row.locked_stock);
      if (row.status !== "active" || available < quantity) return { rows: [], changes: 0 };
      row.locked_stock = num(row.locked_stock) + quantity;
      return { rows: [], changes: 1 };
    }
    // 释放：`WHERE locked_stock >= ?`
    if (num(row.locked_stock) < quantity) return { rows: [], changes: 0 };
    row.locked_stock = num(row.locked_stock) - quantity;
    return { rows: [], changes: 1 };
  }
  if (sql.includes("FROM product_skus s") && sql.includes("JOIN products")) {
    const sku = skus.find((r) => r.id === args[0]);
    if (sku === undefined) return { rows: [], changes: 0 };
    const product = products.find((p) => p.id === sku.product_id);
    if (product === undefined || product.status !== "onsale" || sku.status !== "active") {
      return { rows: [], changes: 0 };
    }
    return { rows: [{ id: sku.id }], changes: 0 };
  }
  if (sql.includes("FROM product_skus")) {
    return {
      rows: skus
        .filter((r) => r.product_id === args[0] && r.status === "active")
        .sort((a, b) => str(a.sku_code).localeCompare(str(b.sku_code))),
      changes: 0,
    };
  }

  /* ---- products ---- */
  if (sql.includes("COUNT(*) AS total FROM products p")) {
    return { rows: [{ total: products.filter((p) => p.status === "onsale").length }], changes: 0 };
  }
  if (sql.includes("FROM products p")) {
    const pageSize = num(args[args.length - 2]);
    const offset = num(args[args.length - 1]);
    const rows = products.filter((p) => p.status === "onsale");
    return {
      rows: rows.slice(offset, offset + pageSize).map((p) => {
        const prices = skus
          .filter((s) => s.product_id === p.id && s.status === "active")
          .map((s) => num(s.price));
        return { ...p, min_price: prices.length === 0 ? null : Math.min(...prices) };
      }),
      changes: 0,
    };
  }
  if (sql.includes("FROM products") && sql.includes("WHERE id = ?")) {
    return { rows: products.filter((r) => r.id === args[0]), changes: 0 };
  }

  /* ---- stores / merchants ---- */
  if (sql.includes("FROM stores")) {
    if (sql.includes("merchant_id = ?")) {
      return {
        rows: stores.filter((r) => r.merchant_id === args[0] && r.status === "active"),
        changes: 0,
      };
    }
    return { rows: stores.filter((r) => r.id === args[0]), changes: 0 };
  }
  if (sql.includes("FROM merchants")) {
    return { rows: merchants.filter((r) => r.id === args[0]), changes: 0 };
  }

  /* ---- cart_items ---- */
  if (sql.includes("INSERT INTO cart_items")) {
    const [id, userId, skuId, quantity, createdAt, updatedAt] = args;
    const existing = cartItems.find((r) => r.user_id === userId && r.sku_id === skuId);
    if (existing !== undefined) {
      existing.quantity = num(existing.quantity) + num(quantity);
      existing.updated_at = updatedAt;
      return { rows: [], changes: 1 };
    }
    cartItems.push({
      id,
      user_id: userId,
      sku_id: skuId,
      quantity,
      selected: 1,
      created_at: createdAt,
      updated_at: updatedAt,
    });
    return { rows: [], changes: 1 };
  }
  if (sql.includes("UPDATE cart_items")) {
    const [quantity, updatedAt, id, userId] = args;
    const row = cartItems.find((r) => r.id === id && r.user_id === userId);
    if (row === undefined) return { rows: [], changes: 0 };
    row.quantity = quantity;
    row.updated_at = updatedAt;
    return { rows: [], changes: 1 };
  }
  if (sql.includes("DELETE FROM cart_items")) {
    if (sql.includes("IN (")) {
      const count = countPlaceholders(sql) - 1;
      const ids = args.slice(1, 1 + count).map(str);
      const userId = str(args[0]);
      let changes = 0;
      for (let i = cartItems.length - 1; i >= 0; i -= 1) {
        const row = cartItems[i];
        if (row !== undefined && row.user_id === userId && ids.includes(str(row.id))) {
          cartItems.splice(i, 1);
          changes += 1;
        }
      }
      return { rows: [], changes };
    }
    const index = cartItems.findIndex((r) => r.id === args[0] && r.user_id === args[1]);
    if (index === -1) return { rows: [], changes: 0 };
    cartItems.splice(index, 1);
    return { rows: [], changes: 1 };
  }
  if (sql.includes("FROM cart_items")) {
    const userId = str(args[0]);
    const ids = sql.includes("AND c.id IN (")
      ? args.slice(1).map(str)
      : sql.includes("AND c.id = ?")
        ? [str(args[1])]
        : undefined;
    return { rows: joinedCartRows(userId, ids), changes: 0 };
  }

  /* ---- orders ---- */
  if (sql.includes("INSERT INTO orders")) {
    const [
      id,
      orderNo,
      userId,
      totalAmount,
      discountAmount,
      freightAmount,
      payAmount,
      addressSnapshot,
      channel,
      payDeadline,
      remark,
      createdAt,
      updatedAt,
    ] = args;
    orders.push({
      id,
      order_no: orderNo,
      user_id: userId,
      status: "PENDING_PAYMENT",
      total_amount: totalAmount,
      discount_amount: discountAmount,
      freight_amount: freightAmount,
      pay_amount: payAmount,
      address_snapshot: addressSnapshot,
      coupon_id: null,
      channel,
      pay_deadline: payDeadline,
      paid_at: null,
      completed_at: null,
      cancelled_at: null,
      remark: remark ?? null,
      created_at: createdAt,
      updated_at: updatedAt,
    });
    return { rows: [], changes: 1 };
  }
  if (sql.includes("INSERT INTO order_status_logs")) {
    const [id, orderId, actorId, occurredAt, createdAt] = args;
    orderStatusLogs.push({
      id,
      order_id: orderId,
      sub_order_id: null,
      kind: "status",
      from_status: null,
      to_status: "PENDING_PAYMENT",
      actor_type: "user",
      actor_id: actorId,
      remark: null,
      occurred_at: occurredAt,
      created_at: createdAt,
    });
    return { rows: [], changes: 1 };
  }
  // ⚠️ 必须先判 `order_no LIKE ?`（`nextOrderSeq` 的当秒序列查询），
  // 否则会被下面的通用 `COUNT(*)` 分支截获，把序列数当成订单总数。
  if (sql.includes("COUNT(*) AS total FROM orders") && sql.includes("order_no LIKE ?")) {
    const prefix = str(args[0]).replace(/%$/, "");
    return {
      rows: [{ total: orders.filter((o) => str(o.order_no).startsWith(prefix)).length }],
      changes: 0,
    };
  }
  if (sql.includes("COUNT(*) AS total FROM orders")) {
    const userId = str(args[0]);
    return { rows: [{ total: orders.filter((o) => o.user_id === userId).length }], changes: 0 };
  }
  if (sql.includes("FROM orders o") && sql.includes("JOIN sub_orders")) {
    const subOrderNo = str(args[0]);
    const skuId = str(args[1]);
    const orderNo = str(args[2]);
    const userId = str(args[3]);
    const order = orders.find((o) => o.order_no === orderNo && o.user_id === userId);
    if (order === undefined) return { rows: [], changes: 0 };
    const sub = subOrders.find((s) => s.order_id === order.id && s.sub_order_no === subOrderNo);
    if (sub === undefined) return { rows: [], changes: 0 };
    const item = orderItems.find((i) => i.sub_order_id === sub.id && i.sku_id === skuId);
    if (item === undefined) return { rows: [], changes: 0 };
    return {
      rows: [
        {
          order_id: order.id,
          sub_order_id: sub.id,
          sub_order_status: sub.status,
          title: item.title,
          unit_price: item.unit_price,
          quantity: item.quantity,
        },
      ],
      changes: 0,
    };
  }
  if (sql.includes("FROM orders") && sql.includes("order_no = ?") && sql.includes("user_id = ?")) {
    return {
      rows: orders.filter((o) => o.order_no === args[0] && o.user_id === args[1]),
      changes: 0,
    };
  }
  if (sql.includes("FROM orders") && sql.includes("WHERE id = ?")) {
    return { rows: orders.filter((o) => o.id === args[0]), changes: 0 };
  }
  if (sql.includes("COUNT(*) AS total FROM orders WHERE user_id")) {
    return { rows: [{ total: orders.filter((o) => o.user_id === args[0]).length }], changes: 0 };
  }
  if (sql.includes("FROM orders")) {
    const userId = str(args[0]);
    const pageSize = num(args[args.length - 2]);
    const offset = num(args[args.length - 1]);
    const rows = orders
      .filter((o) => o.user_id === userId)
      .sort((a, b) => str(b.created_at).localeCompare(str(a.created_at)));
    return { rows: rows.slice(offset, offset + pageSize), changes: 0 };
  }

  /* ---- sub_orders ---- */
  if (sql.includes("INSERT INTO sub_orders")) {
    const [
      id,
      subOrderNo,
      orderId,
      merchantId,
      storeId,
      subtotal,
      discountAlloc,
      freight,
      createdAt,
      updatedAt,
    ] = args;
    subOrders.push({
      id,
      sub_order_no: subOrderNo,
      order_id: orderId,
      merchant_id: merchantId,
      store_id: storeId,
      status: "PAID",
      subtotal,
      discount_alloc: discountAlloc,
      freight,
      commission_amount: 0,
      express_company: null,
      express_company_code: null,
      express_no: null,
      shipped_at: null,
      received_at: null,
      settled: 0,
      created_at: createdAt,
      updated_at: updatedAt,
    });
    return { rows: [], changes: 1 };
  }
  if (sql.includes("FROM sub_orders s")) {
    return {
      rows: subOrders
        .filter((s) => s.order_id === args[0])
        .map((s) => {
          const merchant = merchants.find((m) => m.id === s.merchant_id);
          const store = stores.find((st) => st.id === s.store_id);
          return {
            ...s,
            merchant_name: merchant?.name ?? null,
            merchant_type: merchant?.type ?? null,
            store_name: store?.name ?? null,
            store_city: store?.city ?? null,
            store_province: store?.province ?? null,
          };
        }),
      changes: 0,
    };
  }
  if (sql.includes("sub_order_no FROM sub_orders")) {
    return { rows: subOrders.filter((s) => s.id === args[0]), changes: 0 };
  }
  if (sql.includes("FROM sub_orders") && sql.includes("order_id IN (")) {
    const count = countPlaceholders(sql);
    const ids = args.slice(0, count).map(str);
    return { rows: subOrders.filter((s) => ids.includes(str(s.order_id))), changes: 0 };
  }
  if (sql.includes("FROM sub_orders")) {
    return { rows: subOrders.filter((s) => s.order_id === args[0]), changes: 0 };
  }

  /* ---- order_items ---- */
  if (sql.includes("INSERT INTO order_items")) {
    const [
      id,
      subOrderId,
      orderId,
      spuId,
      skuId,
      title,
      image,
      spec,
      unitPrice,
      quantity,
      subtotal,
      createdAt,
    ] = args;
    orderItems.push({
      id,
      sub_order_id: subOrderId,
      order_id: orderId,
      spu_id: spuId,
      sku_id: skuId,
      title,
      image,
      spec,
      unit_price: unitPrice,
      quantity,
      subtotal,
      created_at: createdAt,
    });
    return { rows: [], changes: 1 };
  }
  if (sql.includes("FROM order_items") && sql.includes("order_id IN (")) {
    const count = countPlaceholders(sql);
    const ids = args.slice(0, count).map(str);
    return { rows: orderItems.filter((i) => ids.includes(str(i.order_id))), changes: 0 };
  }
  if (sql.includes("FROM order_items")) {
    return { rows: orderItems.filter((i) => i.order_id === args[0]), changes: 0 };
  }

  /* ---- aftersales / logs / refunds ---- */
  if (sql.includes("INSERT INTO aftersales")) {
    const [
      id,
      aftersaleNo,
      orderId,
      subOrderId,
      userId,
      skuId,
      itemTitle,
      quantity,
      type,
      reason,
      evidenceUrls,
      refundAmount,
      appliedAt,
      createdAt,
      updatedAt,
    ] = args;
    aftersales.push({
      id,
      aftersale_no: aftersaleNo,
      order_id: orderId,
      sub_order_id: subOrderId,
      user_id: userId,
      sku_id: skuId,
      item_title: itemTitle,
      quantity,
      type,
      status: "PENDING_MERCHANT",
      reason,
      evidence_urls: evidenceUrls,
      refund_amount: refundAmount,
      return_address: null,
      return_express_company: null,
      return_express_no: null,
      deadline_at: null,
      applied_at: appliedAt,
      refunded_at: null,
      created_at: createdAt,
      updated_at: updatedAt,
    });
    return { rows: [], changes: 1 };
  }
  if (sql.includes("INSERT INTO aftersale_logs")) {
    const [id, aftersaleId, actorId, occurredAt, createdAt] = args;
    aftersaleLogs.push({
      id,
      aftersale_id: aftersaleId,
      from_status: null,
      to_status: "PENDING_MERCHANT",
      actor_type: "buyer",
      actor_id: actorId,
      remark: null,
      occurred_at: occurredAt,
      created_at: createdAt,
    });
    return { rows: [], changes: 1 };
  }
  // 同 orders：先判 `aftersale_no LIKE ?`（`nextAftersaleSeq` 的当日序列查询）
  if (sql.includes("COUNT(*) AS total FROM aftersales") && sql.includes("aftersale_no LIKE ?")) {
    const prefix = str(args[0]).replace(/%$/, "");
    return {
      rows: [{ total: aftersales.filter((a) => str(a.aftersale_no).startsWith(prefix)).length }],
      changes: 0,
    };
  }
  if (sql.includes("COUNT(*) AS total FROM aftersales")) {
    const userId = str(args[0]);
    return {
      rows: [{ total: aftersales.filter((a) => a.user_id === userId).length }],
      changes: 0,
    };
  }
  if (sql.includes("SELECT evidence_urls FROM aftersales")) {
    return { rows: aftersales.filter((a) => a.id === args[0]), changes: 0 };
  }
  if (sql.includes("FROM aftersales a")) {
    const userId = str(args[0]);
    const pageSize = num(args[args.length - 2]);
    const offset = num(args[args.length - 1]);
    const rows = aftersales
      .filter((a) => a.user_id === userId)
      .sort((a, b) => str(b.created_at).localeCompare(str(a.created_at)))
      .map((a) => {
        const order = orders.find((o) => o.id === a.order_id);
        return { ...a, order_no: order?.order_no ?? null };
      });
    return { rows: rows.slice(offset, offset + pageSize), changes: 0 };
  }
  if (sql.includes("FROM aftersales") && sql.includes("aftersale_no = ? AND user_id = ?")) {
    return {
      rows: aftersales.filter((a) => a.aftersale_no === args[0] && a.user_id === args[1]),
      changes: 0,
    };
  }
  if (sql.includes("FROM aftersales") && sql.includes("order_id IN (")) {
    const count = countPlaceholders(sql);
    const ids = args.slice(0, count).map(str);
    return { rows: aftersales.filter((a) => ids.includes(str(a.order_id))), changes: 0 };
  }
  if (sql.includes("FROM aftersales")) {
    return { rows: aftersales.filter((a) => a.order_id === args[0]), changes: 0 };
  }
  if (sql.includes("FROM aftersale_logs")) {
    return {
      rows: aftersaleLogs
        .filter((l) => l.aftersale_id === args[0])
        .sort((a, b) => str(a.occurred_at).localeCompare(str(b.occurred_at))),
      changes: 0,
    };
  }
  if (sql.includes("FROM refunds")) {
    return { rows: [], changes: 0 };
  }

  /* ---- payments ---- */
  if (sql.includes("COUNT(*) AS total FROM payments")) {
    const prefix = str(args[0]).replace(/%$/, "");
    return {
      rows: [{ total: payments.filter((p) => str(p.pay_no).startsWith(prefix)).length }],
      changes: 0,
    };
  }
  if (sql.includes("INSERT INTO payments")) {
    const [id, payNo, orderId, channel, channelTradeNo, amount, createdAt, updatedAt] = args;
    payments.push({
      id,
      pay_no: payNo,
      order_id: orderId,
      channel,
      channel_trade_no: channelTradeNo,
      amount,
      status: "PENDING",
      paid_at: null,
      raw_callback: null,
      created_at: createdAt,
      updated_at: updatedAt,
    });
    return { rows: [], changes: 1 };
  }

  // 未识别的 SQL：返回空（与 `agent-contract.test.ts` 同策略，不抛错）
  return { rows: [], changes: 0 };
}

class FakeStatement {
  public constructor(
    private readonly sql: string,
    private readonly args: readonly unknown[] = [],
  ) {}

  public bind(...args: unknown[]): FakeStatement {
    return new FakeStatement(this.sql, args);
  }

  public async first<T>(): Promise<T | null> {
    return (dispatch(this.sql, this.args).rows[0] ?? null) as T | null;
  }

  public async all<T>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
    return {
      results: dispatch(this.sql, this.args).rows as T[],
      success: true,
      meta: { duration: 0 },
    };
  }

  public async run(): Promise<{ success: true; meta: Record<string, unknown> }> {
    const { changes } = dispatch(this.sql, this.args);
    return { success: true, meta: { changes } };
  }
}

/** 内存 fake D1：`batch()` 按序执行并返回各语句结果（语义对齐真实 D1）。 */
function createFakeDb(): D1Database {
  return {
    prepare: (sql: string) => new FakeStatement(sql),
    batch: async (statements: readonly unknown[]) => {
      const results: { success: true; meta: Record<string, unknown> }[] = [];
      for (const statement of statements) {
        const stmt = statement as FakeStatement;
        results.push(await stmt.run());
      }
      return results;
    },
  } as unknown as D1Database;
}

function createEnv(): Env {
  return {
    DB: createFakeDb(),
    AGENT_TOKEN_PEPPER: "test-pepper",
    PHONE_ENC_KEY,
    PHONE_HASH_PEPPER,
    JWT_SECRET,
    // `development` → 短信验证码固定 `123456`（见 `routes/shop/auth.ts`）
    ENVIRONMENT: "development",
  };
}

const executionCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

/* -------------------------------------------------------------------------- */
/* 测试 app                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 挂载 `shopRoutes`（主入口的挂载由 `src/index.ts` 负责，本任务不改它）。
 *
 * ⚠️ `notFound` 必须复刻主入口的全局兜底：按路径前缀取域错误码表，
 * 使未登记的 shop 路径得到字符串 `ERR_SHOP_NOT_FOUND`（而非 Agent 的整数 `40401`）。
 */
const shopApp = new Hono<AppEnv & { Bindings: Env }>();
shopApp.route("/api/v1/shop", shopRoutes);
shopApp.notFound((c) => {
  const codes = backofficeErrorCodesForPath(c.req.path);
  return backofficeErrorResponse(codes.NOT_FOUND, "资源不存在");
});

/**
 * 负向控制用的 app：挂载**真实的** `agentRoutes`。
 *
 * 这里刻意不 import `../src/index.js`：主入口正在被并行改造
 * （它还会挂 merchant 等组），一旦其中任一模块编译失败，
 * 本文件会**整体无法收集**，连 shop 自己的用例都跑不起来。
 * 挂 `agentRoutes` 同样能锁定「Agent 组仍是整数码」这条契约。
 */
const agentApp = new Hono<AppEnv & { Bindings: Env }>();
agentApp.route("/api/v1/agent", agentRoutes);

/* -------------------------------------------------------------------------- */
/* 请求辅助                                                                     */
/* -------------------------------------------------------------------------- */

/** 用户 A 的 shop 令牌（`aud = shop`）。 */
async function shopTokenFor(userId: string): Promise<string> {
  return await signJwt({ sub: userId, role: "customer" }, JWT_SECRET, {
    aud: JWT_AUDIENCE.SHOP,
  });
}

/** 平台后台令牌（`aud = admin`，用于 aud 互斥的负向控制）。 */
async function adminToken(): Promise<string> {
  return await signJwt(
    { sub: "01J9Z8K2M4N5P6Q7R8S9T0ADM1", role: "platform_operator" },
    JWT_SECRET,
    {
      aud: JWT_AUDIENCE.ADMIN,
    },
  );
}

interface CallOptions {
  readonly method?: string;
  readonly body?: unknown;
  readonly token?: string | null;
  readonly idempotencyKey?: string;
}

async function call(path: string, options: CallOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { "X-Contract-Version": "1" };
  if (options.token !== null && options.token !== undefined) {
    headers["Authorization"] = `Bearer ${options.token}`;
  }
  if (options.idempotencyKey !== undefined) {
    headers[IDEMPOTENCY_KEY_HEADER] = options.idempotencyKey;
  }
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  const method = options.method ?? "GET";
  // ⚠️ `Request` 规范禁止 GET / HEAD 带 body——构造时会直接抛 `TypeError`，
  // 表现为「整个文件收集失败」。故只有非 GET/HEAD 才附加 body。
  const canHaveBody = method !== "GET" && method !== "HEAD";

  return await shopApp.request(
    path,
    {
      method,
      headers,
      body: canHaveBody && options.body !== undefined ? JSON.stringify(options.body) : undefined,
    },
    createEnv(),
    executionCtx,
  );
}

interface Envelope {
  readonly code: unknown;
  readonly message: string;
  readonly data: unknown;
}

/** 从响应里取某 `Set-Cookie` 的完整串。 */
function findCookie(res: Response, name: string): string | undefined {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  const all =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : [res.headers.get("set-cookie") ?? ""];
  return all.find((c) => c.startsWith(`${name}=`));
}

/* -------------------------------------------------------------------------- */
/* 生命周期                                                                     */
/* -------------------------------------------------------------------------- */

beforeAll(() => {
  // 预计算用户 A 的 phone_hash（与 `phoneHashOf(PHONE_HASH_PEPPER, ...)` 一致）
});

beforeEach(() => {
  seed();
});

/* -------------------------------------------------------------------------- */
/* 1. 端点清单：20 条全部登记                                                    */
/* -------------------------------------------------------------------------- */

describe("shop 端点登记（docs/06 §6）", () => {
  it("SHOP_ENDPOINT_LIST 恰为 20 条", () => {
    expect(SHOP_ENDPOINT_LIST.length).toBe(20);
  });

  it("shopRoutes 已登记全部 20 条（方法 + 路径模板逐字一致）", () => {
    const registered = new Set(shopRoutes.routes.map((route) => `${route.method} ${route.path}`));
    for (const spec of SHOP_ENDPOINT_LIST) {
      // 契约的 path 是相对 `/api/v1`（如 `/shop/orders`），
      // 而 `shopRoutes` 挂在 `/api/v1/shop` 上，故模板需去掉 `/shop` 前缀。
      const template = spec.path.replace(/^\/shop/, "") || "/";
      expect(
        registered.has(`${spec.method} ${template}`),
        `${spec.method} ${spec.path} 未登记`,
      ).toBe(true);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 2. 认证边界                                                                  */
/* -------------------------------------------------------------------------- */

describe("认证边界（docs/09 §9.1）", () => {
  const PROTECTED: readonly { readonly method: string; readonly path: string }[] = [
    { method: "GET", path: "/api/v1/shop/cart" },
    { method: "POST", path: "/api/v1/shop/cart/items" },
    { method: "PUT", path: `/api/v1/shop/cart/items/${CART_OK_ID}` },
    { method: "DELETE", path: `/api/v1/shop/cart/items/${CART_OK_ID}` },
    { method: "GET", path: "/api/v1/shop/checkout/preview" },
    { method: "GET", path: "/api/v1/shop/addresses" },
    { method: "POST", path: "/api/v1/shop/orders" },
    { method: "GET", path: "/api/v1/shop/orders" },
    { method: "GET", path: `/api/v1/shop/orders/${ORDER_B_NO}` },
    { method: "POST", path: `/api/v1/shop/orders/${ORDER_B_NO}/pay` },
    { method: "POST", path: "/api/v1/shop/aftersales" },
    { method: "GET", path: "/api/v1/shop/aftersales" },
    { method: "GET", path: `/api/v1/shop/aftersales/${AFTERSALE_B_NO}` },
    { method: "POST", path: "/api/v1/shop/auth/logout" },
    { method: "GET", path: "/api/v1/shop/auth/me" },
  ];

  for (const endpoint of PROTECTED) {
    it(`${endpoint.method} ${endpoint.path} 未登录 → 401 + ERR_SHOP_UNAUTHORIZED`, async () => {
      const res = await call(endpoint.path, { method: endpoint.method, body: {} });
      expect(res.status).toBe(401);
      const body = (await res.json()) as Envelope;
      expect(body.code).toBe("ERR_SHOP_UNAUTHORIZED");
      // 负向控制：错误码必须是**字符串**（不是 Agent 组的整数码）
      expect(typeof body.code).toBe("string");
    });
  }

  it("公开端点无需登录：GET /shop/products 与 /shop/categories 返回 200", async () => {
    const products = await call("/api/v1/shop/products");
    expect(products.status).toBe(200);
    const categories = await call("/api/v1/shop/categories");
    expect(categories.status).toBe(200);
  });

  it("admin 令牌访问 shop 端点 → 401（aud 互斥，负向控制）", async () => {
    const res = await call("/api/v1/shop/cart", { token: await adminToken() });
    expect(res.status).toBe(401);
    expect(((await res.json()) as Envelope).code).toBe("ERR_SHOP_UNAUTHORIZED");
  });
});

/* -------------------------------------------------------------------------- */
/* 3. 登录 / 发码 / 手机号脱敏                                                   */
/* -------------------------------------------------------------------------- */

describe("会员登录（docs/08 §8.1）", () => {
  it("POST /auth/sms-code 免鉴权返回 expiresInSeconds", async () => {
    const res = await call("/api/v1/shop/auth/sms-code", {
      method: "POST",
      body: { phone: PHONE_A },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.code).toBe(0);
    expect(body.data).toEqual({ expiresInSeconds: 300 });
  });

  it("60s 冷却内重复发码 → 429 + ERR_SHOP_SMS_CODE_RATE_LIMITED", async () => {
    await call("/api/v1/shop/auth/sms-code", { method: "POST", body: { phone: PHONE_A } });
    const second = await call("/api/v1/shop/auth/sms-code", {
      method: "POST",
      body: { phone: PHONE_A },
    });
    expect(second.status).toBe(429);
    expect(((await second.json()) as Envelope).code).toBe("ERR_SHOP_SMS_CODE_RATE_LIMITED");
  });

  it("错误验证码 → 401 + ERR_SHOP_SMS_CODE_INVALID", async () => {
    await call("/api/v1/shop/auth/sms-code", { method: "POST", body: { phone: PHONE_A } });
    const res = await call("/api/v1/shop/auth/login", {
      method: "POST",
      body: { phone: PHONE_A, code: "000000" },
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as Envelope).code).toBe("ERR_SHOP_SMS_CODE_INVALID");
  });

  it("登录成功签发 aud=shop 的 Cookie，且响应不含明文手机号", async () => {
    await call("/api/v1/shop/auth/sms-code", { method: "POST", body: { phone: PHONE_A } });
    const res = await call("/api/v1/shop/auth/login", {
      method: "POST",
      body: { phone: PHONE_A, code: DEV_SMS_CODE },
    });
    expect(res.status).toBe(200);

    const raw = JSON.stringify(await res.clone().json());
    expect(raw).not.toContain(PHONE_A);
    expect(raw).toContain("138****8000");

    const cookie = findCookie(res, "dshop_shop_at");
    expect(cookie, "登录必须下发 dshop_shop_at Cookie").toBeDefined();
    expect(cookie!).toContain("HttpOnly");
    expect(cookie!).toContain("SameSite=Lax");
  });

  it("首次登录自动建号（users 表新增一行）", async () => {
    const before = users.length;
    await call("/api/v1/shop/auth/sms-code", { method: "POST", body: { phone: "13700137000" } });
    const res = await call("/api/v1/shop/auth/login", {
      method: "POST",
      body: { phone: "13700137000", code: DEV_SMS_CODE },
    });
    expect(res.status).toBe(200);
    expect(users.length).toBe(before + 1);
  });

  it("GET /auth/me 返回脱敏手机号，不含明文", async () => {
    // 用与用户 A 一致的口径构造 phone_hash 不可行（HMAC 需真算），
    // 故此处改用「发码 → 登录 → 用新令牌访问 /me」的端到端链路。
    await call("/api/v1/shop/auth/sms-code", { method: "POST", body: { phone: PHONE_A } });
    const login = await call("/api/v1/shop/auth/login", {
      method: "POST",
      body: { phone: PHONE_A, code: DEV_SMS_CODE },
    });
    const token = login.headers.get("set-cookie")?.match(/dshop_shop_at=([^;]+)/)?.[1];
    expect(token).toBeDefined();

    const me = await call("/api/v1/shop/auth/me", { token: token! });
    expect(me.status).toBe(200);
    const raw = JSON.stringify(await me.clone().json());
    expect(raw).not.toContain(PHONE_A);
    expect(raw).toContain("138****8000");
  });
});

/* -------------------------------------------------------------------------- */
/* 4. 地址簿（C 端完整下发）                                                     */
/* -------------------------------------------------------------------------- */

describe("GET /shop/addresses", () => {
  it("需登录，且 C 端完整下发 receiverPhone（不脱敏）", async () => {
    const res = await call("/api/v1/shop/addresses", { token: await shopTokenFor(USER_A_ID) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    const list = body.data as readonly { readonly receiverPhone: string }[];
    expect(list.length).toBe(1);
    expect(list[0]!.receiverPhone).toBe("13800138000");
  });
});

/* -------------------------------------------------------------------------- */
/* 5. 下单：幂等 + 库存（负向控制）                                              */
/* -------------------------------------------------------------------------- */

describe("POST /shop/orders（docs/05 §5.3②③）", () => {
  it("缺 Idempotency-Key → 400 + ERR_SHOP_INVALID_PARAM", async () => {
    seedCartOk();
    const res = await call("/api/v1/shop/orders", {
      method: "POST",
      token: await shopTokenFor(USER_A_ID),
      body: { addressId: ADDRESS_A_ID },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Envelope).code).toBe("ERR_SHOP_INVALID_PARAM");
  });

  it("同一 key 两次 → 第二次返回首次结果，订单数不增", async () => {
    seedCartOk();
    const token = await shopTokenFor(USER_A_ID);
    const key = "01J9Z8K2M4N5P6Q7R8S9T0KEY1";

    const first = await call("/api/v1/shop/orders", {
      method: "POST",
      token,
      idempotencyKey: key,
      body: { addressId: ADDRESS_A_ID },
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as Envelope;
    const ordersAfterFirst = orders.length;

    const second = await call("/api/v1/shop/orders", {
      method: "POST",
      token,
      idempotencyKey: key,
      body: { addressId: ADDRESS_A_ID },
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as Envelope;

    // 幂等：订单数不增，且两次响应体逐字一致
    expect(orders.length).toBe(ordersAfterFirst);
    expect(secondBody.data).toEqual(firstBody.data);
  });

  it("库存不足 → 409 + ERR_SHOP_STOCK_INSUFFICIENT，且库存**未被扣减**", async () => {
    seedCartLowStock();
    const before = { ...(skus.find((s) => s.id === SKU_LOW_ID) as Row) };

    const res = await call("/api/v1/shop/orders", {
      method: "POST",
      token: await shopTokenFor(USER_A_ID),
      idempotencyKey: "01J9Z8K2M4N5P6Q7R8S9T0KEY2",
      body: { addressId: ADDRESS_A_ID },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Envelope).code).toBe("ERR_SHOP_STOCK_INSUFFICIENT");

    // 负向控制：`stock` 与 `locked_stock` 都必须原封不动
    const after = skus.find((s) => s.id === SKU_LOW_ID) as Row;
    expect(after.stock).toBe(before.stock);
    expect(after.locked_stock).toBe(before.locked_stock);
    expect(orders.length).toBe(1); // 只有种子里的用户 B 那一单
  });

  it("下单成功：写主单 + 子单 + 明细，且库存被**锁定**（非实扣）", async () => {
    seedCartOk();
    const stockBefore = Number((skus.find((s) => s.id === SKU_OK_ID) as Row).stock);

    const res = await call("/api/v1/shop/orders", {
      method: "POST",
      token: await shopTokenFor(USER_A_ID),
      idempotencyKey: "01J9Z8K2M4N5P6Q7R8S9T0KEY3",
      body: { addressId: ADDRESS_A_ID },
    });
    expect(res.status).toBe(200);

    const sku = skus.find((s) => s.id === SKU_OK_ID) as Row;
    // 下单**只锁**：`locked_stock += q`，`stock` 不变（`docs/05` §5.3②）
    expect(Number(sku.stock)).toBe(stockBefore);
    expect(Number(sku.locked_stock)).toBe(1);
    // 购物车已清空
    expect(cartItems.filter((c) => c.user_id === USER_A_ID).length).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 6. 归属隔离（404 而非 403）                                                   */
/* -------------------------------------------------------------------------- */

describe("归属隔离（防枚举）", () => {
  it("用户 A 读用户 B 的订单 → 404 + ERR_SHOP_ORDER_NOT_FOUND", async () => {
    const res = await call(`/api/v1/shop/orders/${ORDER_B_NO}`, {
      token: await shopTokenFor(USER_A_ID),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as Envelope).code).toBe("ERR_SHOP_ORDER_NOT_FOUND");
  });

  it("用户 A 读用户 B 的售后单 → 404 + ERR_SHOP_AFTERSALE_NOT_FOUND", async () => {
    const res = await call(`/api/v1/shop/aftersales/${AFTERSALE_B_NO}`, {
      token: await shopTokenFor(USER_A_ID),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as Envelope).code).toBe("ERR_SHOP_AFTERSALE_NOT_FOUND");
  });

  it("用户 B 自己能读到该订单 → 200（正向上界，证明上一条是归属而非路径问题）", async () => {
    const res = await call(`/api/v1/shop/orders/${ORDER_B_NO}`, {
      token: await shopTokenFor(USER_B_ID),
    });
    expect(res.status).toBe(200);
  });
});

/* -------------------------------------------------------------------------- */
/* 7. 售后：幂等键必填                                                          */
/* -------------------------------------------------------------------------- */

describe("POST /shop/aftersales", () => {
  it("缺 Idempotency-Key → 400", async () => {
    const res = await call("/api/v1/shop/aftersales", {
      method: "POST",
      token: await shopTokenFor(USER_B_ID),
      body: {
        orderNo: ORDER_B_NO,
        subOrderNo: `${ORDER_B_NO}-01`,
        skuId: SKU_OK_ID,
        quantity: 1,
        type: "refund_only",
        reason: "测试",
      },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Envelope).code).toBe("ERR_SHOP_INVALID_PARAM");
  });

  it("归属不属于当前用户 → 404（不泄露存在性）", async () => {
    const res = await call("/api/v1/shop/aftersales", {
      method: "POST",
      token: await shopTokenFor(USER_A_ID),
      idempotencyKey: "01J9Z8K2M4N5P6Q7R8S9T0KEY4",
      body: {
        orderNo: ORDER_B_NO,
        subOrderNo: `${ORDER_B_NO}-01`,
        skuId: SKU_OK_ID,
        quantity: 1,
        type: "refund_only",
        reason: "测试",
      },
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as Envelope).code).toBe("ERR_SHOP_ORDER_NOT_FOUND");
  });

  it("同一 key 两次 → 售后单数不增", async () => {
    const token = await shopTokenFor(USER_B_ID);
    const key = "01J9Z8K2M4N5P6Q7R8S9T0KEY5";
    const payload = {
      orderNo: ORDER_B_NO,
      subOrderNo: `${ORDER_B_NO}-01`,
      skuId: SKU_OK_ID,
      quantity: 1,
      type: "refund_only",
      reason: "测试售后",
    };

    const first = await call("/api/v1/shop/aftersales", {
      method: "POST",
      token,
      idempotencyKey: key,
      body: payload,
    });
    expect(first.status).toBe(200);
    const countAfterFirst = aftersales.length;

    const second = await call("/api/v1/shop/aftersales", {
      method: "POST",
      token,
      idempotencyKey: key,
      body: payload,
    });
    expect(second.status).toBe(200);
    expect(aftersales.length).toBe(countAfterFirst);
  });
});

/* -------------------------------------------------------------------------- */
/* 8. 错误码分层（字符串 vs 整数）                                               */
/* -------------------------------------------------------------------------- */

describe("错误码分层", () => {
  it("shop 路径的错误码是**字符串** ERR_SHOP_*", async () => {
    const res = await call("/api/v1/shop/orders/not-a-valid-order-no", {
      token: await shopTokenFor(USER_A_ID),
    });
    const body = (await res.json()) as Envelope;
    expect(typeof body.code).toBe("string");
    expect(String(body.code).startsWith("ERR_SHOP_")).toBe(true);
  });

  it("未登记的 shop 路径 → 404 + 字符串码（非整数 40401）", async () => {
    const res = await call("/api/v1/shop/no-such-endpoint");
    expect(res.status).toBe(404);
    const body = (await res.json()) as Envelope;
    expect(typeof body.code).toBe("string");
    expect(body.code).toBe("ERR_SHOP_NOT_FOUND");
  });

  it("Agent 组：/api/v1/agent/* 未知路径仍是整数码（负向控制）", async () => {
    // 挂**真实的** `agentRoutes`（而非 `../src/index.js`，见文件头的说明）。
    // 未带服务令牌时先被鉴权拦下，返回整数 `40101`（防探测，见 `error-codes.test.ts`）。
    const res = await agentApp.request(
      "/api/v1/agent/no-such-endpoint",
      { method: "GET", headers: { "X-Contract-Version": "1" } },
      createEnv(),
      executionCtx,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as Envelope;
    expect(typeof body.code).toBe("number");
    expect(body.code).toBe(40101);
  });
});

/* -------------------------------------------------------------------------- */
/* 9. 其余端点可达性（正向 200 / 业务错误，但**不是** 404 未登记）                */
/* -------------------------------------------------------------------------- */

describe("其余端点可达性", () => {
  it("GET /shop/products/:spuId 在售商品 → 200", async () => {
    const res = await call(`/api/v1/shop/products/${SPU_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    const data = body.data as { readonly skus: readonly { readonly stock: number }[] };
    expect(data.skus.map((s) => s.stock).sort((a, b) => a - b)).toEqual([1, 100]);
  });

  it("GET /shop/products/:spuId 未知 SPU → 404 + ERR_SHOP_PRODUCT_NOT_FOUND", async () => {
    // 注意：ULID 校验使用 Crockford Base32（排除 I/L/O/U），故未知 ID 也必须合法，
    // 否则会先被参数校验拦成 400，测不到「查不到」这一分支。
    const res = await call("/api/v1/shop/products/01J9Z8K2M4N5P6Q7R8S9T0ZZZZ");
    expect(res.status).toBe(404);
    expect(((await res.json()) as Envelope).code).toBe("ERR_SHOP_PRODUCT_NOT_FOUND");
  });

  it("GET /shop/cart 返回整车（含可用性与总价）", async () => {
    seedCartOk();
    const res = await call("/api/v1/shop/cart", { token: await shopTokenFor(USER_A_ID) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.data).toMatchObject({ totalAmount: 25800, currency: "CNY" });
  });

  it("POST /shop/cart/items 加购 → 200 且购物车含该行", async () => {
    const res = await call("/api/v1/shop/cart/items", {
      method: "POST",
      token: await shopTokenFor(USER_A_ID),
      body: { skuId: SKU_OK_ID, quantity: 2 },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    const data = body.data as { readonly items: readonly { readonly quantity: number }[] };
    expect(data.items[0]!.quantity).toBe(2);
  });

  it("PUT /shop/cart/items/:id（quantity=0）→ 删除该行", async () => {
    seedCartOk();
    const res = await call(`/api/v1/shop/cart/items/${CART_OK_ID}`, {
      method: "PUT",
      token: await shopTokenFor(USER_A_ID),
      body: { quantity: 0 },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect((body.data as { readonly items: unknown[] }).items.length).toBe(0);
  });

  it("DELETE /shop/cart/items/:id → 200 且幂等（再删仍 200）", async () => {
    seedCartOk();
    const token = await shopTokenFor(USER_A_ID);
    const first = await call(`/api/v1/shop/cart/items/${CART_OK_ID}`, { method: "DELETE", token });
    expect(first.status).toBe(200);
    const second = await call(`/api/v1/shop/cart/items/${CART_OK_ID}`, { method: "DELETE", token });
    expect(second.status).toBe(200);
  });

  it("GET /shop/checkout/preview 按商户分组并给出金额", async () => {
    seedCartOk();
    const res = await call("/api/v1/shop/checkout/preview", {
      token: await shopTokenFor(USER_A_ID),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.data).toMatchObject({
      goodsAmount: 25800,
      freightAmount: 0,
      discountAmount: 0,
      payAmount: 25800,
    });
  });

  it("GET /shop/orders 列表为后台组统一分页形状", async () => {
    const res = await call("/api/v1/shop/orders", { token: await shopTokenFor(USER_B_ID) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.data).toMatchObject({ page: 1, pageSize: 20, total: 1 });
  });

  it("GET /shop/aftersales 列表为后台组统一分页形状", async () => {
    const res = await call("/api/v1/shop/aftersales", { token: await shopTokenFor(USER_B_ID) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.data).toMatchObject({ page: 1, pageSize: 20, total: 1 });
  });

  it("POST /shop/orders/:orderNo/pay 为**占位**：返回 payNo + 渠道参数，不接真实渠道", async () => {
    // 用户 B 的种子订单状态是 PAID，不能发起支付 → 先验状态机，
    // 再用「下单后立即支付」的链路验成功分支。
    const conflict = await call(`/api/v1/shop/orders/${ORDER_B_NO}/pay`, {
      method: "POST",
      token: await shopTokenFor(USER_B_ID),
      body: { channel: "wechat" },
    });
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as Envelope).code).toBe("ERR_SHOP_ORDER_STATE_CONFLICT");

    seedCartOk();
    const token = await shopTokenFor(USER_A_ID);
    const created = await call("/api/v1/shop/orders", {
      method: "POST",
      token,
      idempotencyKey: "01J9Z8K2M4N5P6Q7R8S9T0KEY6",
      body: { addressId: ADDRESS_A_ID },
    });
    expect(created.status).toBe(200);
    const orderNo = ((await created.json()) as Envelope).data as { readonly orderNo: string };

    const pay = await call(`/api/v1/shop/orders/${orderNo.orderNo}/pay`, {
      method: "POST",
      token,
      body: { channel: "wechat" },
    });
    expect(pay.status).toBe(200);
    const payBody = (await pay.json()) as Envelope;
    expect(payBody.data).toMatchObject({ channel: "wechat" });
    // 占位串：明确标注「支付渠道未接入」
    expect(JSON.stringify(payBody.data)).toContain("placeholder://");
    expect(JSON.stringify(payBody.data)).toContain("支付渠道未接入");
  });

  it("POST /shop/auth/logout → 200 且 data 为 null", async () => {
    const res = await call("/api/v1/shop/auth/logout", {
      method: "POST",
      token: await shopTokenFor(USER_A_ID),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.data).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* 10. AES 密文手机号可被解密（加密列口径）                                      */
/* -------------------------------------------------------------------------- */

describe("加密列口径（docs/05 §5.2）", () => {
  it("receiver_phone 存 AES-GCM 密文时也能正确解密下发", async () => {
    const encrypted = await encryptPii(PHONE_ENC_KEY, "13700137000");
    const row = addresses.find((a) => a.id === ADDRESS_A_ID) as Row;
    row.receiver_phone = encrypted;

    const res = await call("/api/v1/shop/addresses", { token: await shopTokenFor(USER_A_ID) });
    expect(res.status).toBe(200);
    const list = ((await res.json()) as Envelope).data as readonly {
      readonly receiverPhone: string;
    }[];
    expect(list[0]!.receiverPhone).toBe("13700137000");
  });
});
