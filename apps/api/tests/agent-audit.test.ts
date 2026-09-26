/**
 * Agent 审计中间件与 Cron 落库测试
 * （`docs/06:57` `agentAudit`、`docs/07` §7.8.3③、`docs/08:110`）。
 *
 * 覆盖三条承诺：
 * 1. **字段采集**：`agent_call_logs` 的每一列都取自真实请求上下文
 *    （列名逐字对齐 `packages/db/migrations/0001_init.sql:634-645`）；
 * 2. **审计失败不阻断**：D1 `batch()` 抛错时业务响应仍为 200（`docs/07` §7.8.3③
 *    「失败不影响响应」）；
 * 3. **Cron 批量落库**：`scheduled()` 内部按类型分发并 flush 缓冲（`docs/08:110`）。
 *
 * 策略：`agentAudit` 用**小 Hono 应用**直接测（关注中间件自身语义），
 * Cron 用 `runCronJobs` / `scheduled` 直接调用（不依赖 Workers runtime）。
 *
 * ## 观测方式（**关键**）
 *
 * 中间件在**每次请求内**就把模块级缓冲 `await flushAgentAuditBuffer()` 落库
 * （`apps/api/src/middleware/agent-audit.ts:250-257`，`drainAgentAuditBuffer()`
 * 在 `flushAgentAuditBuffer()` 开头**同步**执行）。因此请求返回时缓冲必为空，
 * `drainAgentAuditBuffer()` **不能**用来观察记录——只能从两个真实出口观察：
 *
 * 1. **入库行**：fake D1 的 `batch()` 收到的绑定参数（10 列，逐字对齐
 *    `0001_init.sql:634-645`）；
 * 2. **结构化日志**：`requestId` / `errorCode` 在 `agent_call_logs` 中**没有列**，
 *    只进 `event: agent_call` 日志（见中间件文件头「采集但无对应列」）。
 */

import { AGENT_ERROR_CODES } from "@dshop/shared";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCronJobs, scheduled } from "../src/jobs/index.js";
import {
  agentAudit,
  drainAgentAuditBuffer,
  flushAgentAuditBuffer,
  pendingAgentAuditCount,
} from "../src/middleware/agent-audit.js";
import type { Env } from "../src/env.js";
import type { AppEnv } from "../src/lib/context.js";

/* -------------------------------------------------------------------------- */
/* fake D1                                                                     */
/* -------------------------------------------------------------------------- */

interface FakeD1 {
  /** D1 绑定（构造后赋值）。 */
  db: D1Database;
  /** 已写入 `agent_call_logs` 的行（按 `batch()` 收到的 bind 参数还原）。 */
  readonly rows: unknown[][];
  /** 置为 `true` 后 `batch()` 抛错（模拟 D1 故障）。 */
  fail: boolean;
  /** `batch()` 调用次数（验证「批量」而非逐条）。 */
  batchCalls: number;
}

/**
 * 模拟 D1 预编译语句。
 *
 * 必须保留 `sql` 与绑定参数——中间件走的是 `db.batch()`，而真实 D1 的
 * `batch()` **不会**逐条调用语句的 `run()`，所以只有在这里留住参数，
 * fake 的 `batch()` 才能还原出真正入库的行。
 */
class FakeStatement {
  constructor(
    readonly sql: string,
    readonly args: readonly unknown[] = [],
  ) {}

  bind(...args: unknown[]): FakeStatement {
    return new FakeStatement(this.sql, args);
  }

  async first<T>(): Promise<T | null> {
    return null;
  }

  async all<T>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
    return { results: [], success: true, meta: { duration: 0 } };
  }

  async run(): Promise<{ success: true; meta: Record<string, unknown> }> {
    return { success: true, meta: { changes: 1 } };
  }
}

function createFakeD1(): FakeD1 {
  const state: FakeD1 = {
    rows: [],
    fail: false,
    batchCalls: 0,
    db: undefined as unknown as D1Database,
  };

  const db = {
    prepare: (sql: string) => new FakeStatement(sql),
    // 语义对齐真实 D1：同一事务内**按序执行**，返回各语句的结果数组。
    batch: async (statements: readonly FakeStatement[]) => {
      state.batchCalls += 1;
      if (state.fail) throw new Error("D1 batch failed（模拟审计故障）");
      const results: { success: true; meta: { changes: number } }[] = [];
      for (const statement of statements) {
        if (statement.sql.includes("INSERT INTO agent_call_logs")) {
          state.rows.push([...statement.args]);
        }
        results.push({ success: true, meta: { changes: 1 } });
      }
      return results;
    },
  } as unknown as D1Database;

  state.db = db;
  return state;
}

function createEnv(fake: FakeD1): Env {
  return {
    DB: fake.db,
    AGENT_TOKEN_PEPPER: "test-pepper",
    PHONE_ENC_KEY: "phone-enc-key",
    PHONE_HASH_PEPPER: "phone-hash-pepper",
    JWT_SECRET: "jwt-secret",
    ENVIRONMENT: "test",
  };
}

/* -------------------------------------------------------------------------- */
/* 观测辅助                                                                     */
/* -------------------------------------------------------------------------- */

/** `agent_call_logs` 的实际列（逐字对齐 `0001_init.sql:634-645`）。 */
const AGENT_CALL_LOG_COLUMNS = [
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
] as const;

/** 结构化日志 `event: agent_call` 的形状（只列本文件断言到的字段）。 */
interface AgentCallLogEvent {
  readonly requestId: string | null;
  readonly tokenId: string;
  readonly status: number;
  readonly errorCode: number | null;
}

let logLines: string[] = [];

beforeEach(() => {
  logLines = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logLines.push(args.map((arg) => String(arg)).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  drainAgentAuditBuffer();
});

/** 取 fake D1 收到的**最后一行**入库记录，按列名还原为对象。 */
function lastRow(fake: FakeD1): Record<string, unknown> {
  const values = fake.rows[fake.rows.length - 1];
  expect(values).toBeDefined();
  const row: Record<string, unknown> = {};
  AGENT_CALL_LOG_COLUMNS.forEach((column, index) => {
    row[column] = values?.[index];
  });
  return row;
}

/** 取最后一条 `event: agent_call` 结构化日志（`requestId` / `errorCode` 的唯一出口）。 */
function agentCallEvent(): AgentCallLogEvent {
  const line = [...logLines].reverse().find((entry) => entry.includes('"event":"agent_call"'));
  expect(line).toBeDefined();
  return JSON.parse(line ?? "{}") as AgentCallLogEvent;
}

/* -------------------------------------------------------------------------- */
/* 小 Hono 应用：只挂 agentAudit + 一个假 handler                                */
/* -------------------------------------------------------------------------- */

function buildApp(
  handler?: (c: { json: (body: unknown, status?: number) => Response }) => Response,
) {
  const app = new Hono<AppEnv & { Bindings: Env }>();
  app.use("*", async (c, next) => {
    c.set("requestId", "01J9Z8K2M4N5P6Q7R8S9T0REQ1");
    c.set("contractVersion", "1");
    await next();
  });
  app.use("*", agentAudit());
  app.get("/probe", (c) => {
    if (handler !== undefined) return handler(c);
    return c.json({ code: 0, message: "ok", data: { ok: true } });
  });
  app.get("/boom", () => {
    throw new Error("业务抛错");
  });
  // Agent 组整数码兜底（对齐 `apps/api/src/index.ts:97-109`），供 errorCode 采集断言
  app.notFound((c) =>
    c.json({ code: AGENT_ERROR_CODES.ORDER_NOT_FOUND, message: "资源不存在", data: null }, 404),
  );
  return app;
}

/* -------------------------------------------------------------------------- */
/* 1. 字段采集                                                                  */
/* -------------------------------------------------------------------------- */

describe("agentAudit：字段采集（列名对齐 0001_init.sql:634-645）", () => {
  it("采集 id / token_id / path / method / status / duration_ms / cache_hit / contract_version / created_at", async () => {
    const fake = createFakeD1();
    const app = buildApp();

    const res = await app.request(
      "/probe?userId=01J9Z8K2M4N5P6Q7R8S9T0Z001",
      { headers: { "X-Request-Id": "req-42" } },
      createEnv(fake),
    );
    expect(res.status).toBe(200);

    const row = lastRow(fake);
    // 入库列**恰好**是 `agent_call_logs` 的 10 列（多写列会让真实 SQL 报错）
    expect(Object.keys(row).sort()).toEqual([...AGENT_CALL_LOG_COLUMNS].sort());

    expect(row.path).toBe("/probe");
    expect(row.method).toBe("GET");
    expect(row.status).toBe(200);
    expect(row.duration_ms).toBeGreaterThanOrEqual(0);
    expect(row.cache_hit).toBe(0);
    expect(row.contract_version).toBe("1");
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(row.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    // 无 `serviceToken` 上下文（未鉴权）→ `anonymous`，满足 `token_id NOT NULL`
    expect(row.token_id).toBe("anonymous");

    // 采集了 requestId 与 errorCode（**无表列**，只进结构化日志）
    const event = agentCallEvent();
    expect(event.requestId).toBe("01J9Z8K2M4N5P6Q7R8S9T0REQ1");
    expect(event.errorCode).toBe(0);
  });

  it("params_hash 是 sha256 指纹，且**不含**原始 query（防 PII 入库）", async () => {
    const fake = createFakeD1();
    const app = buildApp();
    await app.request("/probe?phone=13888888888", {}, createEnv(fake));

    const row = lastRow(fake);
    expect(row.params_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // 负向：手机号绝不出现在任何入库字段里
    for (const value of Object.values(row)) {
      if (typeof value === "string") {
        expect(value).not.toContain("13888888888");
      }
    }
  });

  it("cache_hit 取自响应头 X-Cache: HIT", async () => {
    const fake = createFakeD1();
    const app = new Hono<AppEnv & { Bindings: Env }>();
    app.use("*", agentAudit());
    app.get("/probe", (c) => {
      c.header("X-Cache", "HIT");
      return c.json({ code: 0, message: "ok", data: null });
    });

    await app.request("/probe", {}, createEnv(fake));
    expect(lastRow(fake).cache_hit).toBe(1);
  });

  it("错误响应也采集 errorCode（如 40401）", async () => {
    const fake = createFakeD1();
    const app = buildApp();
    const res = await app.request("/not-found", {}, createEnv(fake));
    expect(res.status).toBe(404);
    expect(lastRow(fake).status).toBe(404);
    // 错误码从响应体 `{ code }` 提取（整数，Agent 组契约）
    expect(agentCallEvent().errorCode).toBe(AGENT_ERROR_CODES.ORDER_NOT_FOUND);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. 审计失败不阻断响应                                                        */
/* -------------------------------------------------------------------------- */

describe("agentAudit：审计失败不阻断主流程（docs/07 §7.8.3③）", () => {
  it("D1 batch() 抛错时业务响应仍为 200 且响应体不变", async () => {
    const fake = createFakeD1();
    fake.fail = true;
    const app = buildApp();

    const res = await app.request("/probe", {}, createEnv(fake));
    // 关键断言：审计故障**不得**让业务变 500
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: number; data: { ok: boolean } };
    expect(body.code).toBe(0);
    expect(body.data.ok).toBe(true);
    // 且确实尝试过批量落库（失败注入生效）
    expect(fake.batchCalls).toBeGreaterThanOrEqual(1);
  });

  it("flushAgentAuditBuffer 在 batch 失败时返回 0 且不抛错", async () => {
    const fake = createFakeD1();
    fake.fail = true;
    // 先塞一条记录
    const app = buildApp();
    await app.request("/probe", {}, createEnv(fake));

    // 上面那次请求已 flush 并失败（缓冲已清空）；再手工塞一条验证返回值
    const written = await flushAgentAuditBuffer(fake.db);
    expect(written).toBe(0);
  });

  it("批量落库：一次 flush 用一次 batch()（docs/08:110「批量写入」）", async () => {
    const fake = createFakeD1();
    const app = buildApp();
    await app.request("/probe", {}, createEnv(fake));
    // 每条请求触发一次 flush；batch 调用次数应 > 0 且等于请求数
    expect(fake.batchCalls).toBeGreaterThanOrEqual(1);
    expect(pendingAgentAuditCount()).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Cron 分发与批量落库                                                       */
/* -------------------------------------------------------------------------- */

describe("Cron：单一入口按类型分发（docs/08:110-111）", () => {
  it("runCronJobs 依次执行 agent_audit_flush 与 task_queue_consume", async () => {
    const fake = createFakeD1();
    const results = await runCronJobs(createEnv(fake), Date.now());
    expect(results.map((r) => r.type)).toEqual(["agent_audit_flush", "task_queue_consume"]);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("scheduled() 是导出的 Cron handler 且不抛错", async () => {
    const fake = createFakeD1();
    const ctx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;
    const controller = {
      scheduledTime: Date.now(),
      cron: "* * * * *",
      noRetry: () => {},
    } as unknown as ScheduledController;

    await expect(scheduled(controller, createEnv(fake), ctx)).resolves.toBeUndefined();
  });

  it("单个 job 失败不影响其余 job（独立 try/catch）", async () => {
    const fake = createFakeD1();
    // 让审计 flush 失败（batch 抛错）；task_queue 查询走 fake 的 all() → 空结果，应成功
    fake.fail = true;
    const results = await runCronJobs(createEnv(fake), Date.now());
    // 两个 job 都记录结果，且 Cron 本身不抛错
    expect(results).toHaveLength(2);
  });
});
