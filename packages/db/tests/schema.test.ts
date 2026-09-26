/**
 * schema 与手写迁移 SQL 的一致性校验（轻量、无 D1 依赖）。
 *
 * 断言对象：
 * - `src/schema/*` 导出的表对象数量与表名去重数量均为 41
 * - 关键表的列名集合与 `docs/M0-字段契约.md` 一致
 * - `migrations/0001_init.sql` 的 `CREATE TABLE` 出现 41 次
 * - `migrations/0002_seed.sql` 的 `ON CONFLICT` 次数 == `INSERT` 次数（幂等性）
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { ALL_PERMISSIONS, PERMISSIONS, PLATFORM_ROLE, ROLE_PERMISSIONS } from "@dshop/shared";
import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { schema } from "../src/schema/index.js";

/** 41 张表的表名（按域分组，与字段契约 §1–§10 一一对应）。 */
const EXPECTED_TABLES: readonly string[] = [
  // 会员（3）
  "users",
  "user_addresses",
  "user_favorites",
  // 账号（7）
  "admin_users",
  "roles",
  "admin_user_roles",
  "merchant_members",
  "refresh_tokens",
  "service_tokens",
  "audit_logs",
  // 商户（3）
  "merchants",
  "stores",
  "store_stocks",
  // 商品（5）
  "categories",
  "products",
  "product_skus",
  "product_attrs",
  "product_images",
  // 交易（8）
  "cart_items",
  "orders",
  "sub_orders",
  "order_items",
  "order_status_logs",
  "payments",
  "refunds",
  "idempotency_keys",
  // 售后（3）
  "aftersales",
  "aftersale_logs",
  "aftersale_policies",
  // 营销（4）
  "coupon_templates",
  "user_coupons",
  "freight_templates",
  "promotions",
  // 内容（3）
  "reviews",
  "content_blocks",
  "cms_pages",
  // 结算（2）
  "settlements",
  "settlement_items",
  // 支撑（3）
  "task_queue",
  "settings",
  "agent_call_logs",
];

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

function readMigration(name: string): string {
  return readFileSync(path.join(migrationsDir, name), "utf8");
}

/** 去掉 `--` 行注释后的 SQL 正文（避免注释里的示例关键字干扰计数）。 */
function stripSqlComments(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

/** 表名 → 表对象（schema 的键是导出变量名，不是表名，故按 `getTableName` 反查）。 */
function tableByName(tableName: string) {
  const table = Object.values(schema).find((t) => getTableName(t) === tableName);
  if (table === undefined) throw new Error(`schema 中不存在表 ${tableName}`);
  return table;
}

/** 取某表的列名集合（SQL 列名，snake_case）。 */
function columnNames(tableName: string): string[] {
  const columns = getTableColumns(tableByName(tableName)) as Record<string, { name: string }>;
  return Object.values(columns)
    .map((c) => c.name)
    .sort();
}

describe("schema 表清单", () => {
  it("导出 41 个表对象", () => {
    const values = Object.values(schema);
    expect(values).toHaveLength(41);
    expect(values.every((v) => typeof v === "object" && v !== null)).toBe(true);
  });

  it("表名去重后为 41 个，且与字段契约完全一致", () => {
    const names = Object.values(schema).map((t) => getTableName(t));
    expect(new Set(names).size).toBe(41);
    expect([...names].sort()).toEqual([...EXPECTED_TABLES].sort());
  });
});

describe("关键表列名（对照 docs/M0-字段契约.md）", () => {
  it("orders", () => {
    expect(columnNames("orders")).toEqual(
      [
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
      ].sort(),
    );
  });

  it("product_skus", () => {
    expect(columnNames("product_skus")).toEqual(
      [
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
      ].sort(),
    );
  });

  it("aftersales", () => {
    expect(columnNames("aftersales")).toEqual(
      [
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
      ].sort(),
    );
  });

  it("service_tokens", () => {
    expect(columnNames("service_tokens")).toEqual(
      [
        "id",
        "token_hash",
        "token_prefix",
        "name",
        "scopes",
        "status",
        "expires_at",
        "last_used_at",
        "rate_limit_per_min",
        "created_by",
        "revoked_at",
        "revoked_by",
        "rotated_from",
        "created_at",
        "updated_at",
      ].sort(),
    );
  });

  it("agent_call_logs", () => {
    expect(columnNames("agent_call_logs")).toEqual(
      [
        "id",
        "token_id",
        "path",
        "method",
        "params_hash",
        "status",
        "duration_ms",
        "cache_hit",
        "contract_version",
        "created_at",
      ].sort(),
    );
  });

  it("settings 主键是 key，无 id 列", () => {
    expect(columnNames("settings")).toEqual(["description", "key", "updated_at", "value"].sort());
  });
});

describe("schema 与 0001_init.sql 全表列名逐列一致", () => {
  const ddl = readMigration("0001_init.sql");

  /** 解析 DDL：表名 → 列名数组。 */
  function ddlColumns(): Map<string, string[]> {
    const map = new Map<string, string[]>();
    const re = /CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(ddl)) !== null) {
      const table = m[1];
      const body = m[2];
      if (table === undefined || body === undefined) continue;
      map.set(
        table,
        body
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0 && !line.startsWith("--"))
          .map((line) => line.split(/\s+/)[0] ?? "")
          .sort(),
      );
    }
    return map;
  }

  it("41 张表的列名集合完全一致", () => {
    const ddl = ddlColumns();
    expect(ddl.size).toBe(41);
    for (const name of EXPECTED_TABLES) {
      expect(ddl.get(name), `DDL 缺少表 ${name}`).toBeDefined();
      expect(columnNames(name), `表 ${name} 列名不一致`).toEqual(ddl.get(name));
    }
  });
});

describe("migrations/0001_init.sql", () => {
  const sql = readMigration("0001_init.sql");

  it("CREATE TABLE 出现 41 次", () => {
    const matches = sql.match(/CREATE TABLE IF NOT EXISTS/g) ?? [];
    expect(matches).toHaveLength(41);
  });

  it("每条 CREATE TABLE 都是 IF NOT EXISTS", () => {
    const plain = sql.match(/CREATE TABLE(?! IF NOT EXISTS)/g) ?? [];
    expect(plain).toHaveLength(0);
  });

  it("41 张表名全部出现在 DDL 中", () => {
    for (const table of EXPECTED_TABLES) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table} (`);
    }
  });

  it("不声明 SQL 级 FOREIGN KEY", () => {
    expect(stripSqlComments(sql)).not.toMatch(/FOREIGN\s+KEY/i);
  });

  it("契约点名的索引名逐字存在", () => {
    for (const idx of [
      "uq_orders_no",
      "idx_orders_user_time",
      "uq_sub_orders_no",
      "idx_sub_orders_order",
      "uq_aftersales_no",
      "idx_aftersales_sub",
      "idx_product_attrs_spu",
      "idx_skus_product",
      "idx_agent_logs_token_time",
      "uq_store_stocks",
      "uq_user_favorites",
      "uq_payments_trade_no",
      "uq_idempotency_keys",
    ]) {
      expect(sql).toContain(idx);
    }
  });
});

describe("migrations/0002_seed.sql", () => {
  const sql = readMigration("0002_seed.sql");

  it("ON CONFLICT 次数 == INSERT 次数（幂等）", () => {
    const body = stripSqlComments(sql);
    const inserts = body.match(/INSERT INTO/g) ?? [];
    const conflicts = body.match(/ON CONFLICT/g) ?? [];
    expect(inserts.length).toBeGreaterThan(0);
    expect(conflicts).toHaveLength(inserts.length);
  });

  it("roles 插入 8 行，settings 插入 1 行", () => {
    const roleInserts = sql.match(/INSERT INTO roles/g) ?? [];
    const settingInserts = sql.match(/INSERT INTO settings/g) ?? [];
    expect(roleInserts).toHaveLength(8);
    expect(settingInserts).toHaveLength(1);
    expect(sql).toContain("'agent_require_signature'");
    expect(sql).toContain("'false'");
  });

  it("不插入 admin_users（由 scripts/build-seed-sql.ts 派生）", () => {
    expect(sql).not.toMatch(/INSERT INTO admin_users/i);
  });
});

describe("migrations/0002_seed.sql × rbac.ts 防漂移（roles.permissions 必须与代码侧同源）", () => {
  /*
   * ★ 为什么必须有这条测试：`GET /api/v1/admin/me` 的 `permissions` 读的是 DB 的
   * `roles.permissions`（`apps/api/src/repositories/admin-users.ts` 的
   * `findPermissionsForAdmin`），而 `requirePermission` 中间件读的是代码侧的
   * `ROLE_PERMISSIONS`（`packages/shared/src/rbac.ts`）。**两个真相源**一旦漂移，
   * 后果是：超管在 `/admin/me` 看不到新权限点 → 前端菜单级过滤
   * （`apps/admin/src/layout/menu.ts` 按 `permission` 过滤）对所有人隐藏该入口，
   * 而后端 API 却放行。
   *
   * 0002_seed.sql 文件头声明「逐字照录 `packages/shared/src/rbac.ts`」——
   * 本用例把这条**声明**变成可执行的既成事实：新增权限点后若忘了同步种子，
   * 这里立刻变红。
   */
  const SEED_SQL = readMigration("0002_seed.sql");

  /** 在真实 SQLite 引擎上跑 `0002_seed.sql`，返回 `code → permissions[]`。 */
  function seedPermissions(): Map<string, string[]> {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(readMigration("0001_init.sql"));
      db.exec(SEED_SQL);
      const rows = db
        .prepare("SELECT code, permissions FROM roles")
        .all() as { code: string; permissions: string }[];
      const map = new Map<string, string[]>();
      for (const row of rows) {
        const parsed: unknown = JSON.parse(row.permissions);
        map.set(row.code, Array.isArray(parsed) ? (parsed as string[]) : []);
      }
      return map;
    } finally {
      db.close();
    }
  }

  it("每个内置角色的 DB 权限集 ⊇ 代码侧 ROLE_PERMISSIONS（含超管）", () => {
    const seeded = seedPermissions();
    for (const [code, expected] of Object.entries(ROLE_PERMISSIONS)) {
      const actual = seeded.get(code);
      expect(actual, `0002_seed.sql 缺少角色 ${code}`).toBeDefined();
      for (const permission of expected) {
        expect(actual, `角色 ${code} 的种子缺少权限点 ${permission}`).toContain(permission);
      }
    }
  });

  it("★ 平台超管：种子权限集与 ALL_PERMISSIONS 逐项相等（不多不少）", () => {
    const seeded = seedPermissions();
    const superAdmin = seeded.get(PLATFORM_ROLE.SUPER_ADMIN);
    expect(superAdmin).toBeDefined();
    expect([...(superAdmin ?? [])].sort()).toEqual([...ALL_PERMISSIONS].sort());
  });

  it("★ 平台运营：种子权限集与 ROLE_PERMISSIONS 一致，且**不含**死信权限（设计意图）", () => {
    const seeded = seedPermissions();
    const operator = seeded.get(PLATFORM_ROLE.OPERATOR);
    expect(operator).toBeDefined();
    expect([...(operator ?? [])].sort()).toEqual(
      [...(ROLE_PERMISSIONS[PLATFORM_ROLE.OPERATOR] ?? [])].sort(),
    );
    // 死信重放会重新触发业务副作用，**刻意不下放**给日常运营角色
    // （`docs/09` §9.2 的说明；改动此处需先改 rbac.ts 的设计意图）。
    expect(operator).not.toContain(PERMISSIONS.TASK_DEAD_LETTER_MANAGE);
  });
});
