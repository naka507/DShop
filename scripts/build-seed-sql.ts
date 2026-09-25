#!/usr/bin/env node
/**
 * scripts/build-seed-sql.ts —— 由 `data/seed-cs/*.json` 生成/刷新 `data/seed-cs/seed_cs.sql`。
 *
 * 用法：
 *   npx tsx scripts/build-seed-sql.ts
 *   npm run seed:sql
 *
 * 用途：
 *   把需要**密钥现场派生**的字段（`users.phone` 的 AES-GCM 密文、`users.phone_hash` 的 HMAC）
 *   用**运行时环境变量**重新计算；其余字段照 JSON 直出。
 *
 * 环境变量：
 *   PHONE_ENC_KEY       —— `users.phone` 的 AES-GCM 密钥材料（经 SHA-256 派生 32 字节密钥）
 *   PHONE_HASH_PEPPER   —— `users.phone_hash` 的 HMAC-SHA256 胡椒
 *   两者缺省用**开发默认值**，使用时会打印醒目警告。
 *
 * 输出：
 *   data/seed-cs/seed_cs.sql （幂等：全部 `INSERT ... ON CONFLICT(<唯一键>) DO UPDATE SET`）
 *
 * ⚠️ 本文件是**虚构的客服场景数据集**，仅供 dev/staging 导入；**生产环境不得导入**。
 *
 * 幂等性：
 *   - 时间字段一律取自 JSON 或本文件内固定常量，**不使用 `new Date()`**；
 *   - AES-GCM 的 IV 由「手机号 + 密钥」确定性派生（见 `withDeterministicRandom`），
 *     因此同一密钥下重复运行产出**字节级一致**。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encryptPii, hashPhone } from "@dshop/auth";

/* -------------------------------------------------------------------------- */
/* 路径与环境                                                                  */
/* -------------------------------------------------------------------------- */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEED_DIR = resolve(REPO_ROOT, "data/seed-cs");
const OUTPUT_PATH = resolve(SEED_DIR, "seed_cs.sql");

/** 开发默认密钥（**仅 dev**；生产必须由环境注入）。 */
const DEV_PHONE_ENC_KEY = "dshop-dev-phone-enc-key";
const DEV_PHONE_HASH_PEPPER = "dshop-dev-phone-hash-pepper";

const PHONE_ENC_KEY = process.env["PHONE_ENC_KEY"] ?? DEV_PHONE_ENC_KEY;
const PHONE_HASH_PEPPER = process.env["PHONE_HASH_PEPPER"] ?? DEV_PHONE_HASH_PEPPER;

/** 时间常量：`product_attrs` 的 JSON **不含**时间字段，沿用实现侧定案常量（见 scripts/README.md）。 */
const ATTR_CREATED_AT = "2026-06-01T02:00:00.000Z";
const ATTR_UPDATED_AT = "2026-09-18T03:00:00.000Z";

/* -------------------------------------------------------------------------- */
/* SQL 值编码                                                                  */
/* -------------------------------------------------------------------------- */

/** SQL 字面量（字符串已转义、JSON 已序列化）。 */
type SqlValue = string;

/** 转义单引号（`'` → `''`）并加引号。 */
function sqlString(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

/** JSON 列 → SQL 字符串字面量（列类型为 TEXT，存 JSON 文本）。 */
function sqlJson(value: unknown): string {
  return sqlString(JSON.stringify(value));
}

/** 可空文本：`null` → `NULL`。 */
function sqlNullableString(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value !== "string") throw new Error(`期望字符串或 null，收到 ${typeof value}`);
  return sqlString(value);
}

/** 可空 JSON 列：`null` → `NULL`。 */
function sqlNullableJson(value: unknown): string {
  return value === null || value === undefined ? "NULL" : sqlJson(value);
}

/** 整数 / 数值字面量。 */
function sqlNumber(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`期望有限数值，收到 ${String(value)}`);
  }
  return String(value);
}

/* -------------------------------------------------------------------------- */
/* JSON 类型（宽松，字段由本文件的列清单显式取出）                              */
/* -------------------------------------------------------------------------- */

type JsonObject = Record<string, unknown>;

function loadJson(fileName: string): JsonObject[] {
  const text = readFileSync(resolve(SEED_DIR, fileName), "utf8");
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error(`${fileName} 顶层不是数组`);
  return parsed as JsonObject[];
}

/** 取字段（缺失即抛，避免静默产出 `undefined`）。 */
function field(row: JsonObject, key: string): unknown {
  if (!(key in row)) throw new Error(`记录缺少字段 ${key}`);
  return row[key];
}

/* -------------------------------------------------------------------------- */
/* 确定性随机（保证 AES-GCM 密文可重复）                                        */
/* -------------------------------------------------------------------------- */

/** FNV-1a 32 位哈希（用于把种子字符串转成 PRNG 初值）。 */
function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** xorshift32 填充字节（确定性、与平台无关）。 */
function fillDeterministic(out: Uint8Array, seed: number): void {
  let state = seed === 0 ? 0x9e3779b9 : seed;
  for (let i = 0; i < out.length; i += 1) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out[i] = state & 0xff;
  }
}

/** `globalThis.crypto` 的最小视图（`@cloudflare/workers-types` 把 `crypto` 声明为裸全局）。 */
interface MutableCrypto {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

function mutableCrypto(): MutableCrypto {
  const target = globalThis as unknown as { crypto: MutableCrypto };
  return target.crypto;
}

/**
 * 在**确定性随机源**下执行 `encryptPii`。
 *
 * 为什么需要：`encryptPii` 内部用 `crypto.getRandomValues` 生成 12 字节 IV，
 * 天然不可重复；而 `seed_cs.sql` 要求「同一密钥下重复运行字节级一致」。
 * 因此这里用「密钥材料 + 手机号」派生的确定性 IV 流临时替换 `getRandomValues`，
 * 用完立刻恢复。IV 确定性**不降低 dev 种子数据的安全性**（同一手机号本就该得到同一密文）。
 */
async function encryptPiiDeterministic(keyMaterial: string, plaintext: string): Promise<string> {
  const target = mutableCrypto();
  const original = target.getRandomValues;
  const seed = fnv1a32(`${keyMaterial}\u0000${plaintext}`);
  target.getRandomValues = function deterministicGetRandomValues<T extends ArrayBufferView>(
    array: T,
  ): T {
    fillDeterministic(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), seed);
    return array;
  };
  try {
    return await encryptPii(keyMaterial, plaintext);
  } finally {
    target.getRandomValues = original;
  }
}

/* -------------------------------------------------------------------------- */
/* SQL 语句构造                                                                */
/* -------------------------------------------------------------------------- */

/** 一条 `INSERT ... ON CONFLICT(...) DO UPDATE SET ...` 语句。 */
interface InsertStatement {
  /** 目标表名（snake_case）。 */
  readonly table: string;
  /** 列清单（snake_case，顺序即 VALUES 顺序）。 */
  readonly columns: readonly string[];
  /** 每行的 SQL 字面量（长度必须等于 `columns`）。 */
  readonly rows: readonly (readonly SqlValue[])[];
  /** 冲突键（`docs/M0-字段契约.md` §12）。 */
  readonly conflictKey: string;
  /** 该语句上方的小节注释（多行，`--` 前缀）。 */
  readonly comment: readonly string[];
}

/** 渲染一条语句（与现有 `seed_cs.sql` 的版式一致）。 */
function renderStatement(statement: InsertStatement): string {
  const { table, columns, rows, conflictKey, comment } = statement;
  if (rows.length === 0) throw new Error(`${table} 无数据行`);

  const lines: string[] = [];
  for (const line of comment) lines.push(`-- ${line}`.trimEnd());
  if (comment.length > 0) lines.push("");

  lines.push(`INSERT INTO ${table} (${columns.join(", ")}) VALUES`);
  const renderedRows = rows.map((row) => {
    if (row.length !== columns.length) {
      throw new Error(`${table} 某行列数 ${row.length} ≠ 列清单 ${columns.length}`);
    }
    return `  (${row.join(", ")})`;
  });
  lines.push(renderedRows.join(",\n"));

  const assignments = columns
    .filter((column) => column !== conflictKey)
    .map((column) => `${column} = excluded.${column}`);
  lines.push(`ON CONFLICT(${conflictKey}) DO UPDATE SET ${assignments.join(", ")};`);
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* 数据装载（JSON → 语句）                                                      */
/* -------------------------------------------------------------------------- */

const merchants = loadJson("products.json"); // 仅为触发文件存在性检查；商户数据见下
const products = loadJson("products.json");
const attrs = loadJson("product_attrs.json");
const policies = loadJson("aftersale_policies.json");
const orders = loadJson("orders.json");
const aftersales = loadJson("aftersales.json");
const users = loadJson("users.json");
void merchants;

/**
 * `merchants` / `stores` / `categories` **不在任何 JSON 中**（JSON 只引用其 id）。
 * 取值照 `data/seed-cs/README.md` §4 第 14/15 项的定案，逐字照录。
 */
const MERCHANT_ROWS: readonly (readonly SqlValue[])[] = [
  [
    sqlString("01J9Z8K2M4N5P6Q7R8S9T0V1M1"),
    sqlString("self"),
    sqlString("DShop 自营旗舰店"),
    sqlString("https://img.dshop.example.com/m/self-flag.svg"),
    sqlString("自营客服中心"),
    sqlString("057188880000"),
    sqlJson(["https://img.dshop.example.com/m/qualification/business-license.png"]),
    sqlString("approved"),
    sqlNumber(0),
    sqlJson({ bank: "招商银行", account: "****0000", holder: "DShop 自营" }),
    sqlString("平台自营主体，总部统管（Q4 形态 A）"),
    sqlString("2026-01-05T02:00:00.000Z"),
    sqlString("2026-06-01T02:00:00.000Z"),
  ],
];

const STORE_ROWS: readonly (readonly SqlValue[])[] = [
  [
    sqlString("01J9Z8K2M4N5P6Q7R8S9T0V1R1"),
    sqlString("01J9Z8K2M4N5P6Q7R8S9T0V1M1"),
    sqlString("杭州仓"),
    sqlString("warehouse"),
    sqlNumber(120.0789),
    sqlNumber(30.2765),
    sqlString("浙江省"),
    sqlString("杭州市"),
    sqlString("西湖区"),
    sqlString("三墩镇西园一路 8 号"),
    sqlJson({ weekdays: "09:00-18:00", weekend: "10:00-17:00" }),
    sqlNumber(0),
    sqlString("active"),
    sqlString("2026-01-05T02:00:00.000Z"),
    sqlString("2026-06-01T02:00:00.000Z"),
  ],
  [
    sqlString("01J9Z8K2M4N5P6Q7R8S9T0V1R2"),
    sqlString("01J9Z8K2M4N5P6Q7R8S9T0V1M1"),
    sqlString("杭州西湖自提店"),
    sqlString("store"),
    sqlNumber(120.1312),
    sqlNumber(30.2598),
    sqlString("浙江省"),
    sqlString("杭州市"),
    sqlString("西湖区"),
    sqlString("文三路 478 号华星时代广场 1 层"),
    sqlJson({ weekdays: "10:00-21:00", weekend: "10:00-22:00" }),
    sqlNumber(1),
    sqlString("active"),
    sqlString("2026-02-10T02:00:00.000Z"),
    sqlString("2026-06-01T02:00:00.000Z"),
  ],
];

/**
 * `categories` 三级路径：数码 → 耳机 → 真无线耳机；数码 → 音箱 → 便携音箱。
 * 字段顺序：`id, parent_id, name, slug, sort_order, status, created_at, updated_at`。
 */
interface CategorySeed {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly slug: string;
  readonly sortOrder: number;
}

const CATEGORY_SEEDS: readonly CategorySeed[] = [
  { id: "01J9Z8K2M4N5P6Q7R8S9T0V1C1", parentId: null, name: "数码", slug: "digital", sortOrder: 1 },
  { id: "01J9Z8K2M4N5P6Q7R8S9T0V1C2", parentId: "01J9Z8K2M4N5P6Q7R8S9T0V1C1", name: "耳机", slug: "headphone", sortOrder: 1 },
  { id: "01J9Z8K2M4N5P6Q7R8S9T0V1C3", parentId: "01J9Z8K2M4N5P6Q7R8S9T0V1C2", name: "真无线耳机", slug: "tws-earbuds", sortOrder: 1 },
  { id: "01J9Z8K2M4N5P6Q7R8S9T0V1C4", parentId: "01J9Z8K2M4N5P6Q7R8S9T0V1C1", name: "音箱", slug: "speaker", sortOrder: 2 },
  { id: "01J9Z8K2M4N5P6Q7R8S9T0V1C5", parentId: "01J9Z8K2M4N5P6Q7R8S9T0V1C4", name: "便携音箱", slug: "portable-speaker", sortOrder: 1 },
];

const CATEGORY_ROWS: readonly (readonly SqlValue[])[] = CATEGORY_SEEDS.map((category) => [
  sqlString(category.id),
  category.parentId === null ? "NULL" : sqlString(category.parentId),
  sqlString(category.name),
  sqlString(category.slug),
  sqlNumber(category.sortOrder),
  sqlString("active"),
  sqlString("2026-01-05T02:00:00.000Z"),
  sqlString("2026-06-01T02:00:00.000Z"),
]);

/* ---- products / product_skus / product_images ------------------------------ */

const PRODUCT_ROWS: readonly (readonly SqlValue[])[] = products.map((product) => [
  sqlString(field(product, "id") as string),
  sqlString(field(product, "merchant_id") as string),
  sqlString(field(product, "category_id") as string),
  sqlJson(field(product, "category_path")),
  sqlString(field(product, "title") as string),
  sqlNullableString(field(product, "subtitle")),
  sqlNullableString(field(product, "main_image")),
  sqlString(field(product, "detail_html") as string),
  sqlNullableString(field(product, "brand")),
  sqlString(field(product, "status") as string),
  sqlString(field(product, "created_at") as string),
  sqlString(field(product, "updated_at") as string),
]);

const SKU_ROWS: readonly (readonly SqlValue[])[] = products.flatMap((product) => {
  const skus = field(product, "skus") as JsonObject[];
  return skus.map((sku) => [
    sqlString(field(sku, "id") as string),
    sqlString(field(product, "id") as string),
    sqlJson(field(sku, "spec")),
    sqlString(field(sku, "sku_code") as string),
    sqlNumber(field(sku, "price")),
    sqlNumber(field(sku, "market_price")),
    sqlNumber(field(sku, "stock")),
    sqlNumber(field(sku, "locked_stock")),
    sqlNullableString(field(sku, "restock_eta")),
    sqlString(field(sku, "status") as string),
    sqlString(field(sku, "created_at") as string),
    sqlString(field(sku, "updated_at") as string),
  ]);
});

const IMAGE_ROWS: readonly (readonly SqlValue[])[] = products.flatMap((product) => {
  const images = field(product, "images") as JsonObject[];
  return images.map((image) => [
    sqlString(field(image, "id") as string),
    sqlString(field(product, "id") as string),
    sqlString(field(image, "url") as string),
    sqlNumber(field(image, "sort_order")),
    sqlString(field(product, "created_at") as string),
  ]);
});

const ATTR_ROWS: readonly (readonly SqlValue[])[] = attrs.map((attr) => [
  sqlString(field(attr, "id") as string),
  sqlString(field(attr, "spu_id") as string),
  sqlString(field(attr, "group_name") as string),
  sqlString(field(attr, "attr_name") as string),
  sqlString(field(attr, "attr_value") as string),
  sqlNullableString(field(attr, "unit")),
  sqlNumber(field(attr, "sort_order")),
  sqlNumber(field(attr, "searchable")),
  sqlString(ATTR_CREATED_AT),
  sqlString(ATTR_UPDATED_AT),
]);

/* ---- users（phone / phone_hash 现场派生） ---------------------------------- */

interface DerivedUser {
  readonly row: readonly SqlValue[];
  readonly phoneHash: string;
}

async function buildUserRows(): Promise<DerivedUser[]> {
  const derived: DerivedUser[] = [];
  for (const user of users) {
    const plainPhone = field(user, "phone") as string;
    const phoneHash = await hashPhone(PHONE_HASH_PEPPER, plainPhone);
    const encrypted = await encryptPiiDeterministic(PHONE_ENC_KEY, plainPhone);
    derived.push({
      phoneHash,
      row: [
        sqlString(field(user, "id") as string),
        sqlString(encrypted),
        sqlString(phoneHash),
        sqlNullableString(field(user, "nickname")),
        sqlNullableString(field(user, "avatar_url")),
        sqlString(field(user, "status") as string),
        sqlNullableString(field(user, "wechat_openid")),
        sqlNullableString(field(user, "wechat_unionid")),
        sqlString(field(user, "created_at") as string),
        sqlString(field(user, "updated_at") as string),
      ],
    });
  }
  return derived;
}

/* ---- orders / sub_orders / order_items / order_status_logs ----------------- */

const ORDER_ROWS: readonly (readonly SqlValue[])[] = orders.map((order) => [
  sqlString(field(order, "id") as string),
  sqlString(field(order, "order_no") as string),
  sqlString(field(order, "user_id") as string),
  sqlString(field(order, "status") as string),
  sqlNumber(field(order, "total_amount")),
  sqlNumber(field(order, "discount_amount")),
  sqlNumber(field(order, "freight_amount")),
  sqlNumber(field(order, "pay_amount")),
  sqlJson(field(order, "address_snapshot")),
  sqlNullableString(field(order, "coupon_id")),
  sqlString(field(order, "channel") as string),
  sqlNullableString(field(order, "pay_deadline")),
  sqlNullableString(field(order, "paid_at")),
  sqlNullableString(field(order, "completed_at")),
  sqlNullableString(field(order, "cancelled_at")),
  sqlNullableString(field(order, "remark")),
  sqlString(field(order, "created_at") as string),
  sqlString(field(order, "updated_at") as string),
]);

const SUB_ORDER_ROWS: readonly (readonly SqlValue[])[] = orders.flatMap((order) => {
  const subOrders = field(order, "sub_orders") as JsonObject[];
  return subOrders.map((sub) => [
    sqlString(field(sub, "id") as string),
    sqlString(field(sub, "sub_order_no") as string),
    sqlString(field(order, "id") as string),
    sqlString(field(sub, "merchant_id") as string),
    sqlString(field(sub, "store_id") as string),
    sqlString(field(sub, "status") as string),
    sqlNumber(field(sub, "subtotal")),
    sqlNumber(field(sub, "discount_alloc")),
    sqlNumber(field(sub, "freight")),
    sqlNumber(field(sub, "commission_amount")),
    sqlNullableString(field(sub, "express_company")),
    sqlNullableString(field(sub, "express_company_code")),
    sqlNullableString(field(sub, "express_no")),
    sqlNullableString(field(sub, "shipped_at")),
    sqlNullableString(field(sub, "received_at")),
    sqlNumber(field(sub, "settled")),
    sqlString(field(sub, "created_at") as string),
    sqlString(field(sub, "updated_at") as string),
  ]);
});

const ORDER_ITEM_ROWS: readonly (readonly SqlValue[])[] = orders.flatMap((order) => {
  const items = field(order, "order_items") as JsonObject[];
  return items.map((item) => [
    sqlString(field(item, "id") as string),
    sqlString(field(item, "sub_order_id") as string),
    sqlString(field(order, "id") as string),
    sqlString(field(item, "spu_id") as string),
    sqlString(field(item, "sku_id") as string),
    sqlString(field(item, "title") as string),
    sqlNullableString(field(item, "image")),
    sqlJson(field(item, "spec")),
    sqlNumber(field(item, "unit_price")),
    sqlNumber(field(item, "quantity")),
    sqlNumber(field(item, "subtotal")),
    sqlString(field(item, "created_at") as string),
  ]);
});

const ORDER_LOG_ROWS: readonly (readonly SqlValue[])[] = orders.flatMap((order) => {
  const logs = field(order, "order_status_logs") as JsonObject[];
  return logs.map((log) => [
    sqlString(field(log, "id") as string),
    sqlString(field(order, "id") as string),
    sqlNullableString(field(log, "sub_order_id")),
    sqlString(field(log, "kind") as string),
    sqlNullableString(field(log, "from_status")),
    sqlNullableString(field(log, "to_status")),
    sqlString(field(log, "actor_type") as string),
    sqlNullableString(field(log, "actor_id")),
    sqlNullableString(field(log, "remark")),
    sqlString(field(log, "occurred_at") as string),
    sqlString(field(log, "occurred_at") as string),
  ]);
});

/* ---- aftersales / aftersale_logs / aftersale_policies --------------------- */

const AFTERSALE_ROWS: readonly (readonly SqlValue[])[] = aftersales.map((item) => [
  sqlString(field(item, "id") as string),
  sqlString(field(item, "aftersale_no") as string),
  sqlString(field(item, "order_id") as string),
  sqlString(field(item, "sub_order_id") as string),
  sqlString(field(item, "user_id") as string),
  sqlString(field(item, "sku_id") as string),
  sqlString(field(item, "item_title") as string),
  sqlNumber(field(item, "quantity")),
  sqlString(field(item, "type") as string),
  sqlString(field(item, "status") as string),
  sqlNullableString(field(item, "reason")),
  sqlJson(field(item, "evidence_urls")),
  sqlNumber(field(item, "refund_amount")),
  sqlNullableJson(field(item, "return_address")),
  sqlNullableString(field(item, "return_express_company")),
  sqlNullableString(field(item, "return_express_no")),
  sqlNullableString(field(item, "deadline_at")),
  sqlNullableString(field(item, "applied_at")),
  sqlNullableString(field(item, "refunded_at")),
  sqlString(field(item, "created_at") as string),
  sqlString(field(item, "updated_at") as string),
]);

const AFTERSALE_LOG_ROWS: readonly (readonly SqlValue[])[] = aftersales.flatMap((item) => {
  const logs = field(item, "aftersale_logs") as JsonObject[];
  return logs.map((log) => [
    sqlString(field(log, "id") as string),
    sqlString(field(item, "id") as string),
    sqlNullableString(field(log, "from_status")),
    sqlString(field(log, "to_status") as string),
    sqlString(field(log, "actor_type") as string),
    sqlNullableString(field(log, "actor_id")),
    sqlNullableString(field(log, "remark")),
    sqlString(field(log, "occurred_at") as string),
    sqlString(field(log, "occurred_at") as string),
  ]);
});

const POLICY_ROWS: readonly (readonly SqlValue[])[] = policies.map((policy) => [
  sqlString(field(policy, "id") as string),
  sqlString(field(policy, "category") as string),
  sqlString(field(policy, "title") as string),
  sqlString(field(policy, "content") as string),
  sqlString(field(policy, "version") as string),
  sqlString(field(policy, "effective_from") as string),
  sqlNullableString(field(policy, "effective_to")),
  sqlString(field(policy, "status") as string),
  sqlJson(field(policy, "tags")),
  sqlNullableString(field(policy, "created_by")),
  sqlString(field(policy, "created_at") as string),
  sqlString(field(policy, "updated_at") as string),
]);

/* -------------------------------------------------------------------------- */
/* 文件头（保持与现有 seed_cs.sql 一致：虚构声明 + 不得进生产）                  */
/* -------------------------------------------------------------------------- */

function renderHeader(phoneEncKeyIsDefault: boolean, phoneHashPepperIsDefault: boolean): string {
  const keyNote =
    phoneEncKeyIsDefault || phoneHashPepperIsDefault
      ? [
          "-- ⚠️ 本次生成使用了**开发默认密钥**（PHONE_ENC_KEY / PHONE_HASH_PEPPER 未设置）：",
          `--    PHONE_ENC_KEY     = ${phoneEncKeyIsDefault ? PHONE_ENC_KEY : "<环境注入>"}`,
          `--    PHONE_HASH_PEPPER = ${phoneHashPepperIsDefault ? PHONE_HASH_PEPPER : "<环境注入>"}`,
          "--    生产环境必须设置真实密钥后重新生成，不得沿用本文件的派生值。",
        ]
      : [
          "-- 本次生成使用**环境注入密钥**（PHONE_ENC_KEY / PHONE_HASH_PEPPER 均已设置）。",
          "--    （密钥值本身不写入本文件。）",
        ];

  return [
    "-- =============================================================================",
    "-- DShop seed-cs —— 虚构客服场景数据集（dev/staging 专用）",
    "--",
    "-- ⚠️ 本文件是**虚构的客服场景数据集**，仅供开发与验收使用。",
    "--    依据 Q6 决策（M0 允许使用虚构场景数据，见 docs/10 §12.3），",
    "--    生产环境**不得**导入本文件中的任何订单/售后/会员数据。",
    "--",
    "-- 生成来源：scripts/build-seed-sql.ts（数据来源 data/seed-cs/{products,product_attrs,",
    "--   aftersale_policies,orders,aftersales,users}.json；merchants/stores/categories 为脚本内常量）",
    "-- 列名基准：docs/M0-字段契约.md（snake_case，唯一基准）",
    "-- 幂等：全部语句均为 INSERT ... ON CONFLICT(<唯一键>) DO UPDATE SET，可重复执行。",
    "-- 冲突键：docs/M0-字段契约.md §12。",
    "--",
    "-- 时区：时间字段一律 UTC ISO-8601；单号内嵌时间戳一律 UTC+8。",
    "--   DS20260920143000123 ⇔ 2026-09-20T06:30:00.000Z",
    "--",
    "-- users.phone / users.phone_hash：由 PHONE_ENC_KEY / PHONE_HASH_PEPPER **现场派生**",
    "--   （phone = AES-256-GCM(PHONE_ENC_KEY, 明文)，phone_hash = HMAC-SHA256(PHONE_HASH_PEPPER, 明文)）。",
    ...keyNote,
    "-- =============================================================================",
    "",
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* 入口                                                                        */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const encKeyIsDefault = PHONE_ENC_KEY === DEV_PHONE_ENC_KEY;
  const pepperIsDefault = PHONE_HASH_PEPPER === DEV_PHONE_HASH_PEPPER;

  if (encKeyIsDefault || pepperIsDefault) {
    console.warn("[build-seed-sql] ⚠️⚠️ 正在使用**开发默认密钥**：");
    if (encKeyIsDefault) {
      console.warn(`  PHONE_ENC_KEY 未设置 → 回退到 "${DEV_PHONE_ENC_KEY}"`);
    }
    if (pepperIsDefault) {
      console.warn(`  PHONE_HASH_PEPPER 未设置 → 回退到 "${DEV_PHONE_HASH_PEPPER}"`);
    }
    console.warn("  该派生值**仅限 dev/staging**；生产必须注入真实密钥后重新生成。");
  }

  const userRows = await buildUserRows();

  const statements: InsertStatement[] = [
    {
      table: "merchants",
      columns: [
        "id",
        "type",
        "name",
        "logo_url",
        "contact_name",
        "contact_phone",
        "qualification_urls",
        "status",
        "commission_rate_bp",
        "settlement_account",
        "description",
        "created_at",
        "updated_at",
      ],
      rows: MERCHANT_ROWS,
      conflictKey: "id",
      comment: ["商户（merchants）：1 个自营"],
    },
    {
      table: "stores",
      columns: [
        "id",
        "merchant_id",
        "name",
        "type",
        "longitude",
        "latitude",
        "province",
        "city",
        "district",
        "address",
        "business_hours",
        "supports_pickup",
        "status",
        "created_at",
        "updated_at",
      ],
      rows: STORE_ROWS,
      conflictKey: "id",
      comment: ["门店/仓库（stores）：杭州仓（warehouse）+ 杭州西湖自提店（store）"],
    },
    {
      table: "categories",
      columns: ["id", "parent_id", "name", "slug", "sort_order", "status", "created_at", "updated_at"],
      rows: CATEGORY_ROWS,
      conflictKey: "id",
      comment: ["类目（categories）：三级路径 数码→耳机→真无线耳机；数码→音箱→便携音箱"],
    },
    {
      table: "products",
      columns: [
        "id",
        "merchant_id",
        "category_id",
        "category_path",
        "title",
        "subtitle",
        "main_image",
        "detail_html",
        "brand",
        "status",
        "created_at",
        "updated_at",
      ],
      rows: PRODUCT_ROWS,
      conflictKey: "id",
      comment: ["商品（products）"],
    },
    {
      table: "product_skus",
      columns: [
        "id",
        "product_id",
        "spec",
        "sku_code",
        "price",
        "market_price",
        "stock",
        "locked_stock",
        "restock_eta",
        "status",
        "created_at",
        "updated_at",
      ],
      rows: SKU_ROWS,
      conflictKey: "sku_code",
      comment: ["SKU（product_skus）—— 价格单位「分」；可售 = stock - locked_stock"],
    },
    {
      table: "product_attrs",
      columns: [
        "id",
        "spu_id",
        "group_name",
        "attr_name",
        "attr_value",
        "unit",
        "sort_order",
        "searchable",
        "created_at",
        "updated_at",
      ],
      rows: ATTR_ROWS,
      conflictKey: "id",
      comment: [
        "商品参数（product_attrs）",
        "  分组：基本信息 / 技术参数 / 电池续航 / 连接方式 / 防护等级 / 售后与保修 / 包装清单",
        "  ⚠️ 场景③负面断言：全表不存在任何未录入的功能性参数（含各类生理监测功能）。",
        "  时间字段：JSON 未提供，沿用实现侧定案常量（见 scripts/README.md）。",
      ],
    },
    {
      table: "product_images",
      columns: ["id", "product_id", "url", "sort_order", "created_at"],
      rows: IMAGE_ROWS,
      conflictKey: "id",
      comment: ["商品图片（product_images）"],
    },
    {
      table: "users",
      columns: [
        "id",
        "phone",
        "phone_hash",
        "nickname",
        "avatar_url",
        "status",
        "wechat_openid",
        "wechat_unionid",
        "created_at",
        "updated_at",
      ],
      rows: userRows.map((user) => user.row),
      conflictKey: "phone_hash",
      comment: [
        "会员（users）",
        "  phone 加密存储；phone_hash = HMAC-SHA256(PHONE_HASH_PEPPER, 规范化 11 位)",
        "  两者均由 scripts/build-seed-sql.ts 用运行环境密钥现场派生（IV 由手机号确定性派生，保证幂等）。",
      ],
    },
    {
      table: "orders",
      columns: [
        "id",
        "order_no",
        "user_id",
        "status",
        "total_amount",
        "discount_amount",
        "freight_amount",
        "pay_amount",
        "address_snapshot",
        "coupon_id",
        "channel",
        "pay_deadline",
        "paid_at",
        "completed_at",
        "cancelled_at",
        "remark",
        "created_at",
        "updated_at",
      ],
      rows: ORDER_ROWS,
      conflictKey: "order_no",
      comment: ["订单（orders）—— 主单状态由子单聚合，不单独维护"],
    },
    {
      table: "sub_orders",
      columns: [
        "id",
        "sub_order_no",
        "order_id",
        "merchant_id",
        "store_id",
        "status",
        "subtotal",
        "discount_alloc",
        "freight",
        "commission_amount",
        "express_company",
        "express_company_code",
        "express_no",
        "shipped_at",
        "received_at",
        "settled",
        "created_at",
        "updated_at",
      ],
      rows: SUB_ORDER_ROWS,
      conflictKey: "sub_order_no",
      comment: ["子单（sub_orders）—— express_* / shipped_at 是场景②物流查询依据"],
    },
    {
      table: "order_items",
      columns: [
        "id",
        "sub_order_id",
        "order_id",
        "spu_id",
        "sku_id",
        "title",
        "image",
        "spec",
        "unit_price",
        "quantity",
        "subtotal",
        "created_at",
      ],
      rows: ORDER_ITEM_ROWS,
      conflictKey: "id",
      comment: ["订单商品快照（order_items）—— 下单瞬间固化"],
    },
    {
      table: "order_status_logs",
      columns: [
        "id",
        "order_id",
        "sub_order_id",
        "kind",
        "from_status",
        "to_status",
        "actor_type",
        "actor_id",
        "remark",
        "occurred_at",
        "created_at",
      ],
      rows: ORDER_LOG_ROWS,
      conflictKey: "id",
      comment: [
        "订单状态日志 / 物流轨迹（order_status_logs）",
        "  kind = 'status' → 状态流转；kind = 'trace' → 物流轨迹（remark 即 desc，occurred_at 即 time）",
      ],
    },
    {
      table: "aftersales",
      columns: [
        "id",
        "aftersale_no",
        "order_id",
        "sub_order_id",
        "user_id",
        "sku_id",
        "item_title",
        "quantity",
        "type",
        "status",
        "reason",
        "evidence_urls",
        "refund_amount",
        "return_address",
        "return_express_company",
        "return_express_no",
        "deadline_at",
        "applied_at",
        "refunded_at",
        "created_at",
        "updated_at",
      ],
      rows: AFTERSALE_ROWS,
      conflictKey: "aftersale_no",
      comment: ["售后单（aftersales）"],
    },
    {
      table: "aftersale_logs",
      columns: [
        "id",
        "aftersale_id",
        "from_status",
        "to_status",
        "actor_type",
        "actor_id",
        "remark",
        "occurred_at",
        "created_at",
      ],
      rows: AFTERSALE_LOG_ROWS,
      conflictKey: "id",
      comment: ["售后时间线（aftersale_logs）—— Agent /aftersales/{aftersaleNo} 的 timeline 唯一来源"],
    },
    {
      table: "aftersale_policies",
      columns: [
        "id",
        "category",
        "title",
        "content",
        "version",
        "effective_from",
        "effective_to",
        "status",
        "tags",
        "created_by",
        "created_at",
        "updated_at",
      ],
      rows: POLICY_ROWS,
      conflictKey: "id",
      comment: [
        "售后政策（aftersale_policies）—— PiEcho 政策语料唯一来源",
        "  五类全覆盖：return / refund / exchange / freight / warranty",
        "  warranty 正文明确「人为损坏、进液/进水不在保修范围」（场景①依据）",
      ],
    },
  ];

  const body = [
    renderHeader(encKeyIsDefault, pepperIsDefault).trimEnd(),
    "",
    "PRAGMA foreign_keys = OFF;",
    "",
    ...statements.map((statement) => `${renderStatement(statement)}\n`),
    "PRAGMA foreign_keys = ON;",
  ].join("\n");

  const serialized = `${body.trimEnd()}\n`;
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, serialized, "utf8");

  // 与 `data/seed-cs/verify.mjs` 同口径：先剔除整行 `--` 注释再计数。
  const sqlBody = serialized
    .split("\n")
    .filter((line) => !/^\s*--/u.test(line))
    .join("\n");
  const insertCount = (sqlBody.match(/INSERT INTO/g) ?? []).length;
  const conflictCount = (sqlBody.match(/ON CONFLICT/g) ?? []).length;
  const lineCount = serialized.split("\n").length;

  console.log("[build-seed-sql] 写出文件：");
  console.log(`  ${OUTPUT_PATH}`);
  console.log(`[build-seed-sql] 写出行数：${lineCount}`);
  console.log(`[build-seed-sql] INSERT INTO 计数：${insertCount}`);
  console.log(`[build-seed-sql] ON CONFLICT 计数：${conflictCount}`);
  console.log(`[build-seed-sql] 表数量：${statements.length}`);
  console.log(`[build-seed-sql] 记录数：${statements.reduce((sum, s) => sum + s.rows.length, 0)}`);
  console.log(`[build-seed-sql] 字节数：${Buffer.byteLength(serialized, "utf8")}`);

  if (insertCount !== conflictCount) {
    console.error("[build-seed-sql] ❌ INSERT INTO 与 ON CONFLICT 数量不相等");
    process.exitCode = 1;
  }
}

await main();
