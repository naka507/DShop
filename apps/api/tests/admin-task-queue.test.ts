/**
 * 任务死信运维入口契约测试（`/api/v1/admin/task-queue*`，`docs/08:111`、`docs/12` §12.8.2）。
 *
 * ## 本文件锁定的缺陷
 *
 * `docs/08:111`：「`attempts >= TASK_MAX_ATTEMPTS`（=5）置 `failed` **进死信可重放**」；
 * `docs/12:317`：「置 `failed` **进死信，后台可见可重放**」。
 * 修复前**没有任何后台入口**——「可重放」只是文档里的声称。本文件用真实 app +
 * 真实 SQLite D1 把「文档声称」变成「可执行的既成事实」。
 *
 * ## 覆盖的硬性契约
 *
 * 1. 列表默认只返回 `failed`；`status` 为**白名单**，非法值 400。
 * 2. 分页 `LIMIT/OFFSET` + 独立 `COUNT(*)`（`total` 与当前页解耦）。
 * 3. 重放是**原子 UPDATE**：成功后回查 DB 断言 `status/attempts/last_error/run_at`
 *    四项全部落位；非 `failed` 与**未注册类型**一律 409 且**不改库**。
 * 4. ★ **未知路径必须 404，不是 401/403**——这是「逐路由挂中间件」而非
 *    组级 `use("*", ...)` 的结构性证据（负向控制见 §中间件挂载方式）。
 * 5. 畸形 `payload`（非 JSON 字符串）不得让列表/详情 500：死信里恰恰有这类行。
 *
 * ## 测试基建
 *
 * D1 用 `helpers/sqlite-d1.ts`（**真实 SQLite 引擎**，跑 `0001_init.sql` 全量 DDL）；
 * 请求走**真实生产入口** `../src/index.js`，不自建中间件链
 * （与 `merchant-routes.test.ts` / `admin-auth.test.ts` 同纪律）。
 */

import { signJwt } from "@dshop/auth";
import { TASK_TYPE } from "@dshop/services";
import { ADMIN_ERROR_CODES, JWT_AUDIENCE, TASK_QUEUE_STATUS } from "@dshop/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Env } from "../src/env.js";
import app from "../src/index.js";
import { replayFailedTask } from "../src/repositories/task-queue.js";
import { createSqliteD1 } from "./helpers/sqlite-d1.js";
import type { SqliteD1 } from "./helpers/sqlite-d1.js";

/* -------------------------------------------------------------------------- */
/* 固定数据                                                                     */
/* -------------------------------------------------------------------------- */

const JWT_SECRET = "admin-task-queue-test-jwt-secret";

/** 平台超管（`ALL_PERMISSIONS` 自动含 `task:dead_letter:manage`）。 */
const USER_SUPER = "01J9Z8K2M4N5P6Q7R8S9T0TA01";
/** 平台运营（**不含** `task:dead_letter:manage`）。 */
const USER_OPERATOR = "01J9Z8K2M4N5P6Q7R8S9T0TA02";

const ROLE_SUPER = "01J9Z8K2M4N5P6Q7R8S9T0TR01";
const ROLE_OPERATOR = "01J9Z8K2M4N5P6Q7R8S9T0TR02";

const NOW = "2026-09-20T06:30:00.000Z";
const PAST = "2026-09-20T06:00:00.000Z";

/** 后台 Access Token Cookie 名（`middleware/admin-auth.ts:24`）。 */
const ACCESS_COOKIE = "dshop_admin_at";

/** 已注册类型的任务 id（`createTaskHandlers()` 的键集合含 `order.timeout_cancel`）。 */
const TASK_FAILED = "01J9Z8K2M4N5P6Q7R8S9T0TQ01";
const TASK_PENDING = "01J9Z8K2M4N5P6Q7R8S9T0TQ02";
/** 未注册类型（`TASK_TYPE.NOTIFY_SEND` 本版本无 handler）。 */
const TASK_UNREGISTERED = "01J9Z8K2M4N5P6Q7R8S9T0TQ03";
/** 畸形 payload 的 failed 行（非 JSON 字符串）。 */
const TASK_BROKEN_PAYLOAD = "01J9Z8K2M4N5P6Q7R8S9T0TQ04";
/** 已完成任务（`status = done`，用于白名单同源护栏）。 */
const TASK_DONE = "01J9Z8K2M4N5P6Q7R8S9T0TQ05";

const PATH = "/api/v1/admin/task-queue";

/* -------------------------------------------------------------------------- */
/* 内存 D1 + Env                                                               */
/* -------------------------------------------------------------------------- */

let d1: SqliteD1;
/** 平台超管 Access Token。 */
let tokenSuper: string;
/** 平台运营 Access Token。 */
let tokenOperator: string;

function createEnv(): Env {
  return {
    DB: d1.database,
    AGENT_TOKEN_PEPPER: "test-pepper",
    PHONE_ENC_KEY: "phone-enc-key",
    PHONE_HASH_PEPPER: "phone-hash-pepper",
    JWT_SECRET,
    ENVIRONMENT: "test",
  };
}

/** 播种两个平台账号与角色（`roles.permissions` 由 `ROLE_PERMISSIONS` 之外的自定义值承载）。 */
function seed(): void {
  // 超管角色的权限点由代码侧 `ROLE_PERMISSIONS[platform_super_admin] = ALL_PERMISSIONS`
  // 决定（`packages/shared/src/rbac.ts:74`），库里的 `permissions` 列不参与判权，
  // 但仍按真实形态写入，避免测试数据与生产形态漂移。
  d1.run(
    `INSERT INTO roles (id, scope, code, name, permissions, created_at, updated_at)
     VALUES (?, 'platform', 'platform_super_admin', '平台超管', '[]', ?, ?)`,
    ROLE_SUPER,
    NOW,
    NOW,
  );
  d1.run(
    `INSERT INTO roles (id, scope, code, name, permissions, created_at, updated_at)
     VALUES (?, 'platform', 'platform_operator', '平台运营', '[]', ?, ?)`,
    ROLE_OPERATOR,
    NOW,
    NOW,
  );

  for (const [id, username] of [
    [USER_SUPER, "super"],
    [USER_OPERATOR, "operator"],
  ] as const) {
    d1.run(
      `INSERT INTO admin_users
         (id, username, password_hash, nickname, status, totp_secret, totp_enabled,
          failed_attempts, locked_until, created_at, updated_at)
       VALUES (?, ?, 'x', ?, 'active', NULL, 0, 0, NULL, ?, ?)`,
      id,
      username,
      username,
      NOW,
      NOW,
    );
  }

  d1.run(
    `INSERT INTO admin_user_roles (id, admin_user_id, role_id, created_at) VALUES (?, ?, ?, ?)`,
    "01J9Z8K2M4N5P6Q7R8S9T0TUR1",
    USER_SUPER,
    ROLE_SUPER,
    NOW,
  );
  d1.run(
    `INSERT INTO admin_user_roles (id, admin_user_id, role_id, created_at) VALUES (?, ?, ?, ?)`,
    "01J9Z8K2M4N5P6Q7R8S9T0TUR2",
    USER_OPERATOR,
    ROLE_OPERATOR,
    NOW,
  );
}

/** 往 `task_queue` 直接 INSERT 一行（绕过生产者，模拟「死信已在表里」）。 */
function insertTask(input: {
  readonly id: string;
  readonly type: string;
  readonly payload: string;
  readonly status: string;
  readonly attempts: number;
  readonly runAt: string;
  readonly lastError: string | null;
  readonly createdAt?: string;
}): void {
  d1.run(
    `INSERT INTO task_queue
       (id, type, payload, status, attempts, run_at, last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.id,
    input.type,
    input.payload,
    input.status,
    input.attempts,
    input.runAt,
    input.lastError,
    input.createdAt ?? NOW,
    NOW,
  );
}

/** 一行 failed 任务（已注册类型，合法 payload）。 */
function seedFailedTask(): void {
  insertTask({
    id: TASK_FAILED,
    type: TASK_TYPE.ORDER_TIMEOUT_CANCEL,
    payload: JSON.stringify({ orderId: "O1", orderNo: "DS1", createdAtMs: 1 }),
    status: "failed",
    attempts: 5,
    runAt: PAST,
    lastError: "boom",
  });
}

/* -------------------------------------------------------------------------- */
/* 请求基建                                                                     */
/* -------------------------------------------------------------------------- */

interface CallOptions {
  readonly method?: string;
  readonly cookie?: string;
  readonly query?: Record<string, string>;
}

async function call(path: string, options: CallOptions = {}): Promise<Response> {
  const url = new URL(`http://localhost${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(key, value);
  }

  const headers: Record<string, string> = { "X-Contract-Version": "1" };
  if (options.cookie !== undefined) headers["Cookie"] = options.cookie;

  const executionCtx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;

  return await app.request(
    url.toString(),
    { method: options.method ?? "GET", headers },
    createEnv(),
    executionCtx,
  );
}

interface Envelope<T> {
  readonly code: unknown;
  readonly message: string;
  readonly data: T;
}

/** 以真实入口发起请求并解析统一信封。 */
async function callJson<T>(
  path: string,
  options: CallOptions = {},
): Promise<{ status: number; body: Envelope<T> }> {
  const res = await call(path, options);
  return { status: res.status, body: (await res.json()) as Envelope<T> };
}

/** 超管 Cookie。 */
function superCookie(): string {
  return `${ACCESS_COOKIE}=${tokenSuper}`;
}

/** 单条 `task_queue` 行（DB 回查用）。 */
interface TaskRow {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly attempts: number;
  readonly run_at: string;
  readonly last_error: string | null;
  readonly updated_at: string;
}

/** 列表载荷形状（`docs/06:21`：`{ page, pageSize, total, list }`）。 */
interface ListData {
  readonly list: readonly {
    readonly id: string;
    readonly type: string;
    readonly payload: string;
    readonly status: string;
    readonly attempts: number;
    readonly runAt: string;
    readonly lastError: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
  }[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

beforeEach(async () => {
  d1 = createSqliteD1();
  seed();

  tokenSuper = await signJwt(
    { sub: USER_SUPER, role: "platform_super_admin" },
    JWT_SECRET,
    { aud: JWT_AUDIENCE.ADMIN },
  );
  tokenOperator = await signJwt(
    { sub: USER_OPERATOR, role: "platform_operator" },
    JWT_SECRET,
    { aud: JWT_AUDIENCE.ADMIN },
  );
});

afterEach(() => {
  d1.close();
});

/* -------------------------------------------------------------------------- */
/* 1. 列表：默认只列 failed + 状态过滤 + 白名单校验                              */
/* -------------------------------------------------------------------------- */

describe("GET /task-queue", () => {
  it("默认只返回 failed（插一条 pending 一条 failed）", async () => {
    seedFailedTask();
    insertTask({
      id: TASK_PENDING,
      type: TASK_TYPE.ORDER_TIMEOUT_CANCEL,
      payload: "{}",
      status: "pending",
      attempts: 0,
      runAt: NOW,
      lastError: null,
    });

    const { status, body } = await callJson<ListData>(PATH, { cookie: superCookie() });

    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data.total).toBe(1);
    expect(body.data.list).toHaveLength(1);
    expect(body.data.list[0]?.id).toBe(TASK_FAILED);
    expect(body.data.list[0]?.status).toBe("failed");
  });

  it("?status=pending 按状态过滤", async () => {
    seedFailedTask();
    insertTask({
      id: TASK_PENDING,
      type: TASK_TYPE.ORDER_TIMEOUT_CANCEL,
      payload: "{}",
      status: "pending",
      attempts: 0,
      runAt: NOW,
      lastError: null,
    });

    const { status, body } = await callJson<ListData>(PATH, {
      cookie: superCookie(),
      query: { status: "pending" },
    });

    expect(status).toBe(200);
    expect(body.data.total).toBe(1);
    expect(body.data.list[0]?.id).toBe(TASK_PENDING);
  });

  it("?status=bogus → 400 ERR_ADMIN_INVALID_PARAM（白名单外一律拒绝）", async () => {
    seedFailedTask();

    const { status, body } = await callJson<ListData>(PATH, {
      cookie: superCookie(),
      query: { status: "bogus" },
    });

    expect(status).toBe(400);
    expect(body.code).toBe(ADMIN_ERROR_CODES.INVALID_PARAM);
  });

  it("?status=done 可用：白名单必须与消费侧真实落库取值同源", async () => {
    // 回归护栏：消费侧完成态落库写的是 `done`（jobs/task-queue.ts:575 的
    // `SET status = 'done'`），与 `TASK_QUEUE_STATUS.DONE` 一致。
    // 若白名单被手抄成 `succeeded` 之类，这里会 400 —— 运维查「已完成任务」
    // 会拿到 400 并误以为「没有数据」，属于静默功能缺失。
    seedFailedTask();
    insertTask({
      id: TASK_DONE,
      type: TASK_TYPE.ORDER_TIMEOUT_CANCEL,
      payload: "{}",
      status: TASK_QUEUE_STATUS.DONE,
      attempts: 1,
      runAt: PAST,
      lastError: null,
    });

    const { status, body } = await callJson<ListData>(PATH, {
      cookie: superCookie(),
      query: { status: TASK_QUEUE_STATUS.DONE },
    });

    expect(status).toBe(200);
    expect(body.data.total).toBe(1);
    expect(body.data.list[0]?.id).toBe(TASK_DONE);
    expect(body.data.list[0]?.status).toBe(TASK_QUEUE_STATUS.DONE);
  });

  it("白名单覆盖 TASK_QUEUE_STATUS 的每一个取值（不遗漏、不多抄）", async () => {
    // ① 「不遗漏」：逐个真值都必须是合法过滤条件（即 200，而不是 400）。
    for (const value of Object.values(TASK_QUEUE_STATUS)) {
      const { status } = await callJson<ListData>(PATH, {
        cookie: superCookie(),
        query: { status: value },
      });
      expect(status, `status=${value} 应为合法白名单值`).toBe(200);
    }

    // ② 「不多抄」：白名单**只能**是 `TASK_QUEUE_STATUS` 的取值。`succeeded` 是
    //    消费侧 `TaskQueueConsumeResult` 的**计数字段名**，不是落库状态
    //    （落库完成态是 `done`）；若有人把它手抄进白名单，这一条必须变红。
    const { status } = await callJson<ListData>(PATH, {
      cookie: superCookie(),
      query: { status: "succeeded" },
    });
    expect(status, "status=succeeded 不属于 TASK_QUEUE_STATUS，必须 400").toBe(400);
  });

  it("分页：3 条 failed + pageSize=2 → items.length=2 且 total=3", async () => {
    seedFailedTask();
    for (let i = 0; i < 2; i += 1) {
      insertTask({
        id: `01J9Z8K2M4N5P6Q7R8S9T0TP0${i}`,
        type: TASK_TYPE.ORDER_TIMEOUT_CANCEL,
        payload: "{}",
        status: "failed",
        attempts: 5,
        runAt: PAST,
        lastError: "boom",
        // 拉开 `created_at`，让 `created_at DESC` 的排序可断言
        createdAt: `2026-09-20T06:0${i}:00.000Z`,
      });
    }

    const { status, body } = await callJson<ListData>(PATH, {
      cookie: superCookie(),
      query: { pageSize: "2" },
    });

    expect(status).toBe(200);
    expect(body.data.list).toHaveLength(2);
    expect(body.data.total).toBe(3);
    expect(body.data.pageSize).toBe(2);
  });

  it("畸形 payload（非 JSON）不得让列表 500", async () => {
    insertTask({
      id: TASK_BROKEN_PAYLOAD,
      type: TASK_TYPE.ORDER_TIMEOUT_CANCEL,
      payload: "{not-json",
      status: "failed",
      attempts: 5,
      runAt: PAST,
      lastError: "task_payload_invalid",
    });

    const { status, body } = await callJson<ListData>(PATH, { cookie: superCookie() });

    expect(status).toBe(200);
    expect(body.data.list[0]?.payload).toBe("{not-json");
  });
});

/* -------------------------------------------------------------------------- */
/* 2. 详情                                                                      */
/* -------------------------------------------------------------------------- */

describe("GET /task-queue/:id", () => {
  it("命中 → 200 且九个字段齐全", async () => {
    seedFailedTask();

    const { status, body } = await callJson<ListData["list"][number]>(`${PATH}/${TASK_FAILED}`, {
      cookie: superCookie(),
    });

    expect(status).toBe(200);
    expect(body.data.id).toBe(TASK_FAILED);
    expect(body.data.type).toBe(TASK_TYPE.ORDER_TIMEOUT_CANCEL);
    expect(body.data.status).toBe("failed");
    expect(body.data.attempts).toBe(5);
    expect(body.data.runAt).toBe(PAST);
    expect(body.data.lastError).toBe("boom");
    expect(typeof body.data.payload).toBe("string");
    expect(body.data.createdAt).toBe(NOW);
    expect(body.data.updatedAt).toBe(NOW);
  });

  it("不存在 → 404 ERR_ADMIN_TASK_NOT_FOUND", async () => {
    const { status, body } = await callJson<null>(`${PATH}/01J9Z8K2M4N5P6Q7R8S9T0TNOPE`, {
      cookie: superCookie(),
    });

    expect(status).toBe(404);
    expect(body.code).toBe(ADMIN_ERROR_CODES.TASK_NOT_FOUND);
  });

  it("畸形 payload 不得让详情 500", async () => {
    insertTask({
      id: TASK_BROKEN_PAYLOAD,
      type: TASK_TYPE.ORDER_TIMEOUT_CANCEL,
      payload: "not json at all",
      status: "failed",
      attempts: 5,
      runAt: PAST,
      lastError: null,
    });

    const { status, body } = await callJson<{ payload: string }>(
      `${PATH}/${TASK_BROKEN_PAYLOAD}`,
      { cookie: superCookie() },
    );

    expect(status).toBe(200);
    expect(body.data.payload).toBe("not json at all");
  });
});

/* -------------------------------------------------------------------------- */
/* 3. 重放                                                                      */
/* -------------------------------------------------------------------------- */

describe("POST /task-queue/:id/replay", () => {
  it("failed 任务 → 200，且回查 DB 四项落位（status/attempts/last_error/run_at）", async () => {
    seedFailedTask();

    const { status, body } = await callJson<{
      id: string;
      type: string;
      status: string;
      attempts: number;
    }>(`${PATH}/${TASK_FAILED}/replay`, { method: "POST", cookie: superCookie() });

    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data).toEqual({
      id: TASK_FAILED,
      type: TASK_TYPE.ORDER_TIMEOUT_CANCEL,
      status: "pending",
      attempts: 0,
    });

    const row = d1.query<TaskRow>("SELECT * FROM task_queue WHERE id = ?", TASK_FAILED)[0];
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(0);
    expect(row?.last_error).toBeNull();
    // `run_at` 被拉到重放时刻（不再是原来的 PAST），故下一次 Cron tick 即可消费
    expect(row?.run_at).not.toBe(PAST);
    expect(Date.parse(row?.run_at ?? "")).toBeGreaterThan(Date.parse(PAST));
  });

  it("重放落审计（task_queue.replay，docs/09 §9.2）", async () => {
    seedFailedTask();

    await call(`${PATH}/${TASK_FAILED}/replay`, { method: "POST", cookie: superCookie() });

    const logs = d1.query<{ actor_type: string; actor_id: string; action: string; target_id: string }>(
      "SELECT actor_type, actor_id, action, target_id FROM audit_logs WHERE target_id = ?",
      TASK_FAILED,
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]?.actor_type).toBe("admin");
    expect(logs[0]?.actor_id).toBe(USER_SUPER);
    expect(logs[0]?.action).toBe("task_queue.replay");
  });

  it("pending 任务 → 409 ERR_ADMIN_TASK_NOT_FAILED（锁的是 SQL 守卫，不是 TS 判断）", async () => {
    insertTask({
      id: TASK_PENDING,
      type: TASK_TYPE.ORDER_TIMEOUT_CANCEL,
      payload: "{}",
      status: "pending",
      attempts: 0,
      runAt: NOW,
      lastError: null,
    });

    const { status, body } = await callJson<null>(`${PATH}/${TASK_PENDING}/replay`, {
      method: "POST",
      cookie: superCookie(),
    });

    expect(status).toBe(409);
    expect(body.code).toBe(ADMIN_ERROR_CODES.TASK_NOT_FAILED);

    // ★ 本用例现在锁的是 **SQL 守卫**：handler 里已无 TS 侧 `row.status !== "failed"`
    //   前置判断，「只有失败态可重放」的唯一权威是 `replayFailedTask` 那条
    //   `UPDATE ... WHERE id = ? AND status = 'failed'` 的 `changes === 0`
    //   （`apps/api/src/routes/admin/task-queue.ts` 步骤 c）。把 `WHERE` 里的
    //   `status = 'failed'` 删掉，这一条会立刻变红。
    // 且**不改库**：状态与 `run_at` 保持原样。
    const row = d1.query<TaskRow>("SELECT * FROM task_queue WHERE id = ?", TASK_PENDING)[0];
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(0);
    expect(row?.run_at).toBe(NOW);
  });

  it("不存在 → 404 ERR_ADMIN_TASK_NOT_FOUND", async () => {
    const { status, body } = await callJson<null>(
      `${PATH}/01J9Z8K2M4N5P6Q7R8S9T0TNOPE/replay`,
      { method: "POST", cookie: superCookie() },
    );

    expect(status).toBe(404);
    expect(body.code).toBe(ADMIN_ERROR_CODES.TASK_NOT_FOUND);
  });

  it("未注册类型 → 409 ERR_ADMIN_TASK_TYPE_UNREGISTERED，且库中状态未被改动", async () => {
    insertTask({
      id: TASK_UNREGISTERED,
      type: TASK_TYPE.NOTIFY_SEND,
      payload: "{}",
      status: "failed",
      attempts: 5,
      runAt: PAST,
      lastError: "boom",
    });

    const { status, body } = await callJson<null>(`${PATH}/${TASK_UNREGISTERED}/replay`, {
      method: "POST",
      cookie: superCookie(),
    });

    expect(status).toBe(409);
    expect(body.code).toBe(ADMIN_ERROR_CODES.TASK_TYPE_UNREGISTERED);

    // ★ 必须先判类型再写库：把跑不了的任务塞回 pending 会让它反复抢占失败
    const row = d1.query<TaskRow>("SELECT * FROM task_queue WHERE id = ?", TASK_UNREGISTERED)[0];
    expect(row?.status).toBe("failed");
    expect(row?.attempts).toBe(5);
    expect(row?.last_error).toBe("boom");
    expect(row?.run_at).toBe(PAST);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. 鉴权与中间件挂载方式                                                       */
/* -------------------------------------------------------------------------- */

/*
 * ⚠️ 三条端点**各自**都要有负向控制。此前 401/403 用例只打列表与重放，
 * 详情路由的两条中间件被删掉后测试**全绿**——「详情端点完全无鉴权」这一回归
 * 无法被发现，而详情返回的 `payload` 是明文。故每条端点都各测 401 与 403。
 */

describe("鉴权", () => {
  it("未登录（不带 Cookie）→ 401（列表 / 详情 / 重放三端点各自成立）", async () => {
    seedFailedTask();

    const list = await call(PATH);
    expect(list.status).toBe(401);

    // ★ 详情端点单独一条：删掉它的 `requireAdminAuth()` 会让这一条变红。
    const detail = await call(`${PATH}/${TASK_FAILED}`);
    expect(detail.status).toBe(401);

    const replay = await call(`${PATH}/${TASK_FAILED}/replay`, { method: "POST" });
    expect(replay.status).toBe(401);
  });

  it("已登录但角色权限不足（platform_operator）→ 403（三端点各自成立）", async () => {
    seedFailedTask();
    const operatorCookie = `${ACCESS_COOKIE}=${tokenOperator}`;

    const res = await call(PATH, { cookie: operatorCookie });
    expect(res.status).toBe(403);

    const body = (await res.json()) as Envelope<null>;
    expect(body.code).toBe(ADMIN_ERROR_CODES.PERMISSION_DENIED);

    // ★ 详情端点单独一条：删掉它的 `requirePermission(...)` 会让这一条变红
    //   （详情返回明文 `payload`，漏权限即数据泄漏）。
    const detail = await call(`${PATH}/${TASK_FAILED}`, { cookie: operatorCookie });
    expect(detail.status).toBe(403);
    const detailBody = (await detail.json()) as Envelope<null>;
    expect(detailBody.code).toBe(ADMIN_ERROR_CODES.PERMISSION_DENIED);

    // 重放同样被拦（且不改库）
    const replay = await call(`${PATH}/${TASK_FAILED}/replay`, {
      method: "POST",
      cookie: operatorCookie,
    });
    expect(replay.status).toBe(403);
    const row = d1.query<TaskRow>("SELECT * FROM task_queue WHERE id = ?", TASK_FAILED)[0];
    expect(row?.status).toBe("failed");
  });

  it("★ 未知路径 → 404（不是 401/403）：中间件是逐路由挂载的", async () => {
    // 不带 Cookie 也必须是 404：若三个路由改写成组级 `use("*", ...)`，
    // 这一条会先被鉴权拦成 401，测试即失败（负向控制）。
    const anon = await call(`${PATH}/x/y`);
    expect(anon.status).toBe(404);

    const anonBody = (await anon.json()) as Envelope<null>;
    expect(anonBody.code).toBe(ADMIN_ERROR_CODES.NOT_FOUND);

    // 带超管 Cookie 同样 404（不存在该端点，而不是被 RBAC 拦成 403）
    const authed = await call(`${PATH}/x/y`, { cookie: superCookie() });
    expect(authed.status).toBe(404);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. 仓储层：SQL 守卫必须真的在 WHERE 里（竞态安全的唯一证据）                    */
/* -------------------------------------------------------------------------- */

/*
 * ⚠️ 为什么单独测仓储（P2-1 修完后端点层**也**能观测到，但仓储层仍是最直接的证据）：
 * 端点层的 `pending → 409` 用例（§3）与这里的 `changes === 0` 现在锁的是**同一条**
 * SQL 守卫——handler 已无 TS 侧前置判断。这里额外锁定并发语义：两次调用只有一次
 * `changes === 1`，这是「单条原子 UPDATE」而非「先查后写」的**唯一**证据，
 * 端点层无法表达（两次 `findTaskById` 都可能读到 `failed`）。
 */

describe("replayFailedTask（仓储层 SQL 守卫）", () => {
  it("pending 行 → changes=0 且状态不变（守卫在 SQL 的 WHERE 里，不在 TS 里）", async () => {
    insertTask({
      id: TASK_PENDING,
      type: TASK_TYPE.ORDER_TIMEOUT_CANCEL,
      payload: "{}",
      status: "pending",
      attempts: 0,
      runAt: NOW,
      lastError: null,
    });

    const changes = await replayFailedTask(d1.database, {
      id: TASK_PENDING,
      nowIso: "2026-09-20T07:00:00.000Z",
    });

    expect(changes).toBe(0);
    const row = d1.query<TaskRow>("SELECT * FROM task_queue WHERE id = ?", TASK_PENDING)[0];
    expect(row?.status).toBe("pending");
    expect(row?.run_at).toBe(NOW);
    expect(row?.updated_at).toBe(NOW);
  });

  it("并发重放同一 failed 行：两次调用只有一次 changes=1（不会双重重放）", async () => {
    seedFailedTask();

    const [first, second] = await Promise.all([
      replayFailedTask(d1.database, { id: TASK_FAILED, nowIso: "2026-09-20T07:00:00.000Z" }),
      replayFailedTask(d1.database, { id: TASK_FAILED, nowIso: "2026-09-20T07:00:00.000Z" }),
    ]);

    expect([first, second].sort((a, b) => a - b)).toEqual([0, 1]);
    const row = d1.query<TaskRow>("SELECT * FROM task_queue WHERE id = ?", TASK_FAILED)[0];
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(0);
  });
});
