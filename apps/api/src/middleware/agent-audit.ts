/**
 * Agent 调用审计中间件（`docs/06:57` `agentAudit`、`docs/07` §7.8.3③、`docs/08:110`）。
 *
 * ## 为什么需要它
 *
 * `docs/07` §7.11 的六项 SLO（可用性 / 延迟 P95 / 限流拒绝率 / 数据新鲜度 …）
 * 与 `docs/04` §4.3 的 S10/S11 触发阈值，**唯一数据源是 `agent_call_logs`**
 * （`docs/08:110`：「★ `agent_call_logs` 落库｜Cron 每分钟｜批量写入 Agent 调用审计。
 * **SLO 监测与 S10/S11 触发阈值的唯一数据源**」）。此前全仓库无任何写入，
 * 六项 SLO 因此**不可度量**。
 *
 * ## 列名基准（**以 SQL 为准**）
 *
 * `packages/db/migrations/0001_init.sql:634-645`：
 *
 * | 列 | 说明 | 本中间件取值 |
 * | --- | --- | --- |
 * | `id` | PK（ULID） | `newId()` |
 * | `token_id` | 服务令牌 id | 上下文 `serviceToken.id`；未认证时为 `"anonymous"` |
 * | `path` | 请求路径 | `c.req.path`（**非**模板，便于按真实路径排查） |
 * | `method` | HTTP 方法 | `c.req.method` |
 * | `params_hash` | 参数指纹 | `sha256:<hex>` of `path?query`（**不落原始 query**，避免 PII 入库） |
 * | `status` | HTTP 状态码 | `c.res.status` |
 * | `duration_ms` | 耗时 | `Date.now()` 差值 |
 * | `cache_hit` | 缓存命中 | 响应头 `X-Cache: HIT` → `1`，否则 `0` |
 * | `contract_version` | 契约版本 | 上下文 `contractVersion` |
 * | `created_at` | 落库时间 | `new Date().toISOString()` |
 *
 * ⚠️ **采集但无对应列**：`requestId` 与 `errorCode` 在 `agent_call_logs` 中
 * **没有列**（表结构见上）。二者仍被采集并进结构化日志（`event: agent_call`），
 * **不新增列**（41 张表结构冻结，见 `docs/M0-字段契约.md` §1–§10）。
 *
 * ## 失败不阻断（`docs/07` §7.8.3③）
 *
 * 「唯一写入是 `agent_call_logs`（审计），走独立异步路径，**失败不影响响应**」。
 * 因此本中间件：
 * 1. 只在 `await next()` **之后**采集（此时 `serviceToken` / 状态码均已就绪）；
 * 2. 落库走 `waitUntil`（不阻塞响应）；`waitUntil` 不可用时 `await` 但**吞掉异常**；
 * 3. 任何异常只 `console.warn` 告警，**绝不让业务变 500**。
 *
 * ## 批量缓冲
 *
 * 每次调用把记录推进模块级缓冲，再由 `flushAgentAuditBuffer()` 用 D1 `batch()`
 * 一次写多行（`docs/08:110`「批量写入」）。缓冲由：
 * - 每次请求的 `waitUntil` 触发一次 flush（同 isolate 内并发请求自然合并）；
 * - Cron 每分钟兜底 flush（`apps/api/src/jobs/index.ts`，`docs/08:110`）。
 *
 * ⚠️ **isolate 边界**：模块级缓冲是 **per-isolate** 的，Cron 与请求通常不在同一
 * isolate，故 Cron 只能兜底同一 isolate 内的残留。这是「不新增表」前提下的
 * 折中；后续若需强一致，应按 `docs/08:111` 的 `task_queue` 模式落表。
 */

import { sha256Hex } from "@dshop/auth";
import { newId } from "@dshop/shared";
import type { MiddlewareHandler } from "hono";

import type { Env } from "../env.js";
import type { AppEnv } from "../lib/context.js";

/** `agent_call_logs` 一行（列名逐字对齐 `0001_init.sql:634-645`）。 */
export interface AgentCallLogRow {
  readonly id: string;
  readonly token_id: string;
  readonly path: string;
  readonly method: string;
  readonly params_hash: string | null;
  readonly status: number;
  readonly duration_ms: number;
  readonly cache_hit: number;
  readonly contract_version: string | null;
  readonly created_at: string;
}

/**
 * 采集到的完整调用记录。
 *
 * 比 `AgentCallLogRow` 多出 `requestId` / `errorCode`——这两项**没有对应列**，
 * 只进结构化日志（见文件头）。
 */
export interface AgentCallRecord extends AgentCallLogRow {
  /** 请求 ID（`X-Request-Id` 响应头同源）。 */
  readonly requestId: string | null;
  /**
   * 业务错误码：整数（`AGENT_ERROR_CODES`，Agent 组契约）或 `null`（成功）。
   * 仅用于日志与 SLO 统计口径，不入库。
   */
  readonly errorCode: number | null;
}

/** 缓冲上限：达到即立刻 flush，避免长 isolate 内存膨胀。 */
export const AGENT_AUDIT_BUFFER_LIMIT = 100;

/** 模块级待落库缓冲（per-isolate，见文件头「isolate 边界」）。 */
const buffer: AgentCallRecord[] = [];

/** 供测试与运维观察缓冲深度。 */
export function pendingAgentAuditCount(): number {
  return buffer.length;
}

/** 取出并清空缓冲（flush 的唯一入口，避免并发 flush 写重）。 */
export function drainAgentAuditBuffer(): AgentCallRecord[] {
  return buffer.splice(0, buffer.length);
}

/** 从响应体里取整数错误码（`{ code: <int> }`）；失败返回 `null`。 */
async function extractErrorCode(res: Response): Promise<number | null> {
  // 仅当响应是 JSON 且 code 为整数时取值；失败一律 null（不因解析失败影响审计）
  const contentType = res.headers.get("Content-Type") ?? "";
  if (!contentType.includes("application/json")) return null;
  try {
    const parsed: unknown = JSON.parse(await res.clone().text());
    if (typeof parsed !== "object" || parsed === null) return null;
    const code = (parsed as { code?: unknown }).code;
    return typeof code === "number" && Number.isInteger(code) ? code : null;
  } catch {
    return null;
  }
}

/**
 * 安全取 `ExecutionContext`。
 *
 * ⚠️ Hono 的 `c.executionCtx` getter 在**没有** ExecutionContext 时**抛错**
 * （`hono/dist/context.js` 的 `get executionCtx()`），故不能用可选链兜底，
 * 必须 try/catch。测试中 `app.request(..., env)` 不传 ctx 时即走此分支。
 */
function safeExecutionCtx(c: object): ExecutionContext | null {
  try {
    return (c as { executionCtx: ExecutionContext }).executionCtx;
  } catch {
    return null;
  }
}

/**
 * 批量落库缓冲中的记录（`docs/08:110`）。
 *
 * 用 D1 `batch()` 一次提交多行；**任何失败只告警**，不抛给调用方。
 *
 * @returns 成功写入的行数（失败返回 0）
 */
export async function flushAgentAuditBuffer(db: D1Database): Promise<number> {
  const rows = drainAgentAuditBuffer();
  if (rows.length === 0) return 0;

  try {
    const statements = rows.map((row) =>
      db
        .prepare(
          `INSERT INTO agent_call_logs
             (id, token_id, path, method, params_hash, status, duration_ms, cache_hit,
              contract_version, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          row.id,
          row.token_id,
          row.path,
          row.method,
          row.params_hash,
          row.status,
          row.duration_ms,
          row.cache_hit,
          row.contract_version,
          row.created_at,
        ),
    );

    await db.batch(statements);
    return rows.length;
  } catch (err) {
    // 审计失败**不阻断主流程**（`docs/07` §7.8.3③）：只告警
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "agent_audit_flush_failed",
        count: rows.length,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return 0;
  }
}

/**
 * Agent 组审计中间件。
 *
 * 挂载位置：入口层 `accessLog()` **之后**、`agentRoutes` **之前**
 * （`apps/api/src/index.ts`）。记录发生在 `await next()` 之后，
 * 因此 `serviceTokenAuth` / `requireScope` / `rateLimit` 写入上下文的
 * `serviceToken` 与最终状态码都可用——语义上等价于挂在鉴权之后，
 * 同时**额外覆盖 401 / 403 / 405 / 429** 等未进入业务 handler 的调用
 * （这些恰恰是 SLO「限流拒绝率」与「可用性」要统计的部分）。
 */
export const agentAudit = (): MiddlewareHandler<AppEnv & { Bindings: Env }> => async (c, next) => {
  const start = Date.now();
  await next();
  const durationMs = Date.now() - start;

  try {
    const url = new URL(c.req.url);
    const fingerprint = `${url.pathname}?${url.searchParams.toString()}`;
    const token = c.get("serviceToken");
    const res = c.res;

    const record: AgentCallRecord = {
      id: newId(),
      // 未通过鉴权时无令牌身份：按 `anonymous` 归类，避免 token_id NOT NULL 违约
      token_id: token?.id ?? "anonymous",
      path: c.req.path,
      method: c.req.method,
      // 只落指纹，不落原始 query（`userId` / `phone` 属 PII）
      params_hash: `sha256:${await sha256Hex(fingerprint)}`,
      status: res.status,
      duration_ms: durationMs,
      cache_hit: res.headers.get("X-Cache") === "HIT" ? 1 : 0,
      contract_version: c.get("contractVersion") ?? null,
      created_at: new Date().toISOString(),
      requestId: c.get("requestId") ?? null,
      errorCode: await extractErrorCode(res),
    };

    buffer.push(record);

    // 缓冲超限：立刻同步落库一次（不丢记录；正常路径下缓冲每次 flush 即清空）
    if (buffer.length > AGENT_AUDIT_BUFFER_LIMIT) {
      await flushAgentAuditBuffer(c.env.DB);
    }

    // 结构化日志：`requestId` / `errorCode` 无表列，只能在这里留痕
    // 结构化日志是 Workers 运行时的唯一出口，此处有意使用 console.log
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        level: "info",
        event: "agent_call",
        requestId: record.requestId,
        tokenId: record.token_id,
        endpoint: record.path,
        method: record.method,
        status: record.status,
        durationMs: record.duration_ms,
        errorCode: record.errorCode,
        createdAt: record.created_at,
      }),
    );

    // 异步落库：不阻塞响应（`docs/07` §7.8.3③）
    const task = flushAgentAuditBuffer(c.env.DB);
    const ctx = safeExecutionCtx(c);
    if (ctx !== null && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(task);
    } else {
      await task;
    }
  } catch (err) {
    // 采集/落库自身异常绝不影响响应（审计是旁路）
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "agent_audit_failed",
        path: c.req.path,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
};
