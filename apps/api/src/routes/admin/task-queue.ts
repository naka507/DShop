/**
 * 任务死信运维入口（`docs/08:111`、`docs/12` §12.8.2、`docs/09` §9.2）。
 *
 * - `GET  /api/v1/admin/task-queue`             —— 死信/任务列表（默认只列 `failed`）
 * - `GET  /api/v1/admin/task-queue/:id`         —— 任务详情
 * - `POST /api/v1/admin/task-queue/:id/replay`  —— 重放失败任务
 *
 * ## 为什么必须有（本文件是缺陷修复的另一半）
 *
 * `docs/08:111`：「`attempts >= TASK_MAX_ATTEMPTS`（=5）置 `failed` **进死信可重放**」；
 * `docs/12:317`：「置 `failed` **进死信，后台可见可重放**」。
 * 但修复前**没有任何后台入口**——「可重放」只是文档里的声称，实际只能人肉连 D1 改库。
 * 本文件把 {@link ../../repositories/task-queue.js} 的三个原语挂成真实端点。
 *
 * ## 权限
 *
 * 三条端点都要求权限点 `task:dead_letter:manage`（`packages/shared/src/rbac.ts`）。
 * 平台超管经 `ALL_PERMISSIONS` 自动持有；**平台运营不持有**（死信重放会重新触发
 * 业务副作用，不应下放给日常运营角色）。
 *
 * ## 列表响应形状
 *
 * `GET /task-queue` 的 `data` 是 `{ page, pageSize, total, list }`（`docs/06:21`
 * 的 shop / admin / merchant 三组统一分页），由契约中心的
 * `AdminTaskQueueListSchema`（`packages/shared/src/contracts/admin.ts`）产出并经
 * `safeParse` 校验后才返回——**信封字段是 `list` 而非 `items`**。
 *
 * ## 中间件必须「逐路由挂载」
 *
 * ⚠️ **不用**组级 `use("*", ...)`：组级通配会把**未登记的路径**也先拦成
 * 401/403，使 `GET /api/v1/admin/task-queue/x/y` 拿不到 404，而是被误报成
 * 「未登录」。未知路径的 404 由 `apps/api/src/index.ts` 的全局 `notFound`
 * 按路径前缀给出 `ERR_ADMIN_NOT_FOUND`（`docs/README.md:34`）。
 * `routes/merchant/business.ts` 的模块头注释记录了同一条取舍。
 *
 * ## 错误码
 *
 * 全部字符串码 `ADMIN_ERROR_CODES`（`docs/README.md:34`）。
 */

import {
  ADMIN_ERROR_CODES,
  AdminTaskQueueListSchema,
  AdminTaskQueueListQuerySchema,
  PERMISSIONS,
  type Permission,
} from "@dshop/shared";
import { Hono } from "hono";

import type { Env } from "../../env.js";
import { createTaskHandlers } from "../../jobs/task-queue.js";
import type { AppEnv } from "../../lib/context.js";
import { backofficeErrorResponse, successResponse } from "../../lib/errors.js";
import { requireAdminAuth } from "../../middleware/admin-auth.js";
import { requirePermission } from "../../middleware/rbac.js";
import { AUDIT_ACTOR_TYPE, insertAuditLog } from "../../repositories/audit-logs.js";
import {
  findTaskById,
  listTaskQueue,
  replayFailedTask,
} from "../../repositories/task-queue.js";
import type { TaskQueueRow } from "../../repositories/task-queue.js";

export const taskQueueAdminRoutes = new Hono<AppEnv & { Bindings: Env }>();

/*
 * `status` 白名单与分页参数**不再在此定义**：已上移到契约中心
 * `AdminTaskQueueListQuerySchema`（`packages/shared/src/contracts/admin.ts`），
 * 与 `ShopOrderListQuerySchema` 同层。放在路由里现场定义（P2-2）会让
 * 「契约」只存在于实现侧，前端与文档无从同源引用。
 */
/** 死信重放权限（`packages/shared/src/rbac.ts`，超管自动持有）。 */
const REPLAY_PERMISSION: Permission = PERMISSIONS.TASK_DEAD_LETTER_MANAGE;

/**
 * 把行映射为响应视图（列名 → camelCase，`payload` **原样字符串**）。
 *
 * ⚠️ 刻意**不**解析 `payload`：死信里本就有「payload 损坏」的行
 * （`jobs/task-queue.ts:272` 的 `task_payload_invalid`），在响应组装处
 * `JSON.parse` 会让运维入口对最需要被看到的那批行直接 500。
 */
function taskView(row: TaskQueueRow) {
  return {
    id: row.id,
    type: row.type,
    payload: row.payload,
    status: row.status,
    attempts: row.attempts,
    runAt: row.run_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 该类型在本版本是否已注册处理器。
 *
 * ★ 判据是**消费侧的真实注册表** {@link createTaskHandlers} 的键集合，
 * 不另立一份类型清单——否则两张表会漂移，把「本版本跑不了的任务」塞回队列。
 */
function isRegisteredTaskType(db: D1Database, type: string): boolean {
  return Object.prototype.hasOwnProperty.call(createTaskHandlers(db), type);
}

/* -------------------------------------------------------------------------- */
/* GET /task-queue                                                             */
/* -------------------------------------------------------------------------- */

taskQueueAdminRoutes.get(
  "/task-queue",
  requireAdminAuth(),
  requirePermission(REPLAY_PERMISSION),
  async (c) => {
    const parsed = AdminTaskQueueListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return backofficeErrorResponse(
        ADMIN_ERROR_CODES.INVALID_PARAM,
        parsed.error.issues[0]?.message ?? "查询参数非法",
      );
    }

    const result = await listTaskQueue(c.env.DB, {
      status: parsed.data.status,
      type: parsed.data.type,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
    });

    // ★ 响应形状必须**校验后**再返回，且信封字段是 `list`（不是 `items`）：
    // `docs/06:21` 规定 shop / admin / merchant 三组统一 `{ page, pageSize, total, list }`，
    // 管理端唯一取页函数 `apps/admin/src/api/client.ts` 的 `getPage` 只认 `data.list`
    // ——用 `items` 会让任何页面拿到「空表格 + 非零 total」（静默丢数据）。
    // 校验失败按既有通用内部错误码返回（不新增错误码）。
    const validated = AdminTaskQueueListSchema.safeParse({
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      list: result.items.map(taskView),
    });
    if (!validated.success) {
      return backofficeErrorResponse(
        ADMIN_ERROR_CODES.INTERNAL_ERROR,
        "任务队列列表响应不符合契约",
      );
    }

    return successResponse(validated.data);
  },
);

/* -------------------------------------------------------------------------- */
/* GET /task-queue/:id                                                         */
/* -------------------------------------------------------------------------- */

taskQueueAdminRoutes.get(
  "/task-queue/:id",
  requireAdminAuth(),
  requirePermission(REPLAY_PERMISSION),
  async (c) => {
    const row = await findTaskById(c.env.DB, c.req.param("id"));
    if (row === null) {
      return backofficeErrorResponse(ADMIN_ERROR_CODES.TASK_NOT_FOUND);
    }
    return successResponse(taskView(row));
  },
);

/* -------------------------------------------------------------------------- */
/* POST /task-queue/:id/replay                                                 */
/* -------------------------------------------------------------------------- */

taskQueueAdminRoutes.post(
  "/task-queue/:id/replay",
  requireAdminAuth(),
  requirePermission(REPLAY_PERMISSION),
  async (c) => {
    const id = c.req.param("id");

    // a. 存在性
    const row = await findTaskById(c.env.DB, id);
    if (row === null) {
      return backofficeErrorResponse(ADMIN_ERROR_CODES.TASK_NOT_FOUND);
    }

    // b. ★ 类型必须先判**再写库**：把本版本跑不了的任务塞回 `pending`，
    //    消费侧会把它当作可运行任务反复抢占失败，最终再次进死信——
    //    重放不但无效，还会消耗槽位（`jobs/task-queue.ts` 的槽位饥饿说明）。
    if (!isRegisteredTaskType(c.env.DB, row.type)) {
      return backofficeErrorResponse(ADMIN_ERROR_CODES.TASK_TYPE_UNREGISTERED);
    }

    const subject = c.get("adminSubject");
    const nowIso = new Date().toISOString();

    // c. ★ 「只有失败态可重放」的**唯一权威**是下面这条原子 UPDATE 的
    //    `changes === 0`，守卫写在 **SQL 的 `WHERE` 里**（`repositories/task-queue.ts`
    //    的 `replayFailedTask`）——这是本仓「守卫放 SQL、不放 TS」的纪律。
    //    刻意**不**在 TS 侧加 `row.status !== "failed"` 前置判断：
    //    ① 它会引入 `findTaskById` 与 `replayFailedTask` 之间的 TOCTOU 窗口
    //       （两次读到的都可能是 `failed`，并发下双双重放）；
    //    ② 它会让 SQL 守卫**不可被端点层观测**——把 `WHERE status = 'failed'`
    //       删掉，端点测试照样全绿，回归无法被发现。
    const changes = await replayFailedTask(c.env.DB, { id, nowIso });
    if (changes === 0) {
      return backofficeErrorResponse(ADMIN_ERROR_CODES.TASK_NOT_FAILED);
    }

    // d. 审计（`docs/09` §9.2：「后台所有写操作落 audit_logs」）
    await insertAuditLog(c.env.DB, {
      actorType: AUDIT_ACTOR_TYPE.ADMIN,
      actorId: subject.sub,
      action: "task_queue.replay",
      targetType: "task_queue",
      targetId: id,
      before: {
        status: row.status,
        attempts: row.attempts,
        lastError: row.last_error,
      },
      after: { status: "pending", attempts: 0, runAt: nowIso },
      ip: c.req.header("CF-Connecting-IP") ?? null,
      userAgent: c.req.header("User-Agent") ?? null,
      createdAt: nowIso,
    });

    // e. 回显重放后的队列态（不是回显旧行）
    return successResponse({
      id,
      type: row.type,
      status: "pending",
      attempts: 0,
    });
  },
);
