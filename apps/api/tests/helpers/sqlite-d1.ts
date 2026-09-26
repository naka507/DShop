/**
 * 内存 D1 测试替身：用 Node 内置 `node:sqlite` **真实执行 SQL**。
 *
 * ## 为什么不用「按 SQL 模式分发」的假实现
 *
 * 本任务的核心验收点是**商户行级隔离在 SQL 层强制注入**（`docs/09` §9.2）。
 * 若用「正则匹配 SQL 片段 → 返回硬编码行」的替身，测试只能证明「代码调用了某个
 * SQL 字符串」，**证明不了** `WHERE merchant_id = ?` 真的过滤掉了别的商户——
 * 因为替身根本没执行 `WHERE`。
 *
 * 故这里用真实 SQLite 引擎跑 `packages/db/migrations/0001_init.sql` 的全量 DDL，
 * 让「商户 A 的令牌查不到商户 B 的订单」成为**数据库层面的既成事实**。
 *
 * ## 与真实 D1 的差异（诚实登记）
 *
 * - **无网络/无分布式语义**：`batch()` 用 SQLite 事务模拟 D1 的原子批；
 *   D1 的 `batch` 本身即「同一事务内按序执行」，语义一致。
 * - **`meta.changes` 取自 `run()` 的 `changes`**：与 D1 一致。
 * - **不模拟 D1 的 `UNIQUE` 约束错误文案**：`node:sqlite` 报
 *   `UNIQUE constraint failed: <表>.<列>`，D1 报 `D1_ERROR: UNIQUE constraint failed: ...`；
 *   生产代码的判定用正则同时覆盖两者（见 `repositories/merchant-callbacks.ts`）。
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const MIGRATION_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/migrations/0001_init.sql",
);

/** 单条语句的执行结果（对齐 D1 的 `D1Result`）。 */
interface D1ResultLike {
  readonly success: true;
  readonly results: unknown[];
  readonly meta: Record<string, unknown>;
}

/** `node:sqlite` 的 Statement 与 D1 的 `D1PreparedStatement` 的桥接。 */
class SqliteStatement {
  public constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly args: readonly unknown[] = [],
  ) {}

  public bind(...args: unknown[]): SqliteStatement {
    return new SqliteStatement(this.db, this.sql, args);
  }

  public async first<T>(): Promise<T | null> {
    const rows = this.allSync();
    return (rows[0] ?? null) as T | null;
  }

  public async all<T>(): Promise<D1ResultLike & { results: T[] }> {
    return { success: true, results: this.allSync() as T[], meta: { duration: 0 } };
  }

  public async run(): Promise<D1ResultLike> {
    const result = this.db.prepare(this.sql).run(...(this.args as never[]));
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
    };
  }

  /** 同步执行并取全部行（`first()` 与 `all()` 共用）。 */
  public allSync(): Record<string, unknown>[] {
    return this.db.prepare(this.sql).all(...(this.args as never[])) as Record<string, unknown>[];
  }
}

/** 内存 D1 替身（真实 SQLite 引擎）。 */
export interface SqliteD1 {
  /** 作为 `D1Database` 传入 `Env`。 */
  readonly database: D1Database;
  /** 直接执行 SQL（测试播种 / 断言用）。 */
  exec(sql: string): void;
  /** 直接执行参数化写语句（测试播种用）。 */
  run(sql: string, ...args: unknown[]): void;
  /** 直接执行参数化查询（测试断言用）。 */
  query<T>(sql: string, ...args: unknown[]): T[];
  /** 关闭底层句柄。 */
  close(): void;
}

/**
 * 建一个**空 schema** 的内存 D1（不导入任何种子数据）。
 *
 * 每个测试文件在 `beforeEach` 里自行播种，保证用例间零耦合。
 */
export function createSqliteD1(): SqliteD1 {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(MIGRATION_PATH, "utf8"));

  const database = {
    prepare: (sql: string) => new SqliteStatement(db, sql),
    /**
     * D1 的 `batch()`：同一事务内按序执行，全部成功才提交。
     *
     * 用 `BEGIN` / `COMMIT` / `ROLLBACK` 显式包一层，使「唯一约束冲突 → 整批回滚」
     * 与 D1 语义一致（生产代码的幂等兜底依赖这条）。
     */
    batch: async (statements: readonly { run: () => Promise<unknown> }[]) => {
      db.exec("BEGIN");
      try {
        const results: unknown[] = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;

  return {
    database,
    exec: (sql) => db.exec(sql),
    run: (sql, ...args) => {
      db.prepare(sql).run(...(args as never[]));
    },
    query: <T>(sql: string, ...args: unknown[]) => db.prepare(sql).all(...(args as never[])) as T[],
    close: () => db.close(),
  };
}
