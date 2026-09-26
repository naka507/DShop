/**
 * 后台运营契约（契约中心，零业务逻辑）。
 *
 * 权威来源：
 * - `docs/09-认证权限与部署.md` §9.2 两个 PiEcho 专属权限点与三入口
 * - `docs/06-API路由命名空间.md:37-39` 的三条路由示例
 * - `docs/07-Agent-API契约.md` §7.8.1（令牌格式、180 天有效期、四个读 scope）
 * - `packages/db/migrations/0001_init.sql` 的 `service_tokens` / `aftersale_policies` 列名
 *
 * ⚠️ 本文件的响应体错误码为**字符串**（`ADMIN_ERROR_CODES`，`docs/README.md:34`），
 * 与 Agent 组的整数码严格分离。
 */

import { z } from "zod";
import {
  AGENT_SCOPE,
  AgentScopeSchema,
  POLICY_CATEGORY,
  POLICY_STATUS,
  PolicyCategorySchema,
  PolicyStatusSchema,
  TASK_QUEUE_STATUS,
  type TaskQueueStatus,
} from "../enums.js";
import { UlidSchema } from "../ids.js";
import { IsoDateTimeSchema, PageQuerySchema, pageResultSchema } from "./common.js";

export {
  AGENT_SCOPE,
  AgentScopeSchema,
  POLICY_CATEGORY,
  POLICY_STATUS,
  PolicyCategorySchema,
  PolicyStatusSchema,
};

/** 令牌级默认限流（07 §7.8.1 / `service_tokens.rate_limit_per_min` 默认值）。 */
export const ADMIN_AGENT_TOKEN_DEFAULT_RATE_LIMIT_PER_MIN = 600;

/** 令牌默认有效期天数（07 §7.8.1：180 天）。 */
export const ADMIN_AGENT_TOKEN_DEFAULT_TTL_DAYS = 180;

/** 令牌有效期上限（超出即拒绝，避免签发事实上的永久令牌）。 */
export const ADMIN_AGENT_TOKEN_MAX_TTL_DAYS = 365;

/** TOTP 码格式（6 位数字，`packages/auth/src/totp.ts`）。 */
export const TOTP_CODE_PATTERN = /^\d{6}$/;

/* -------------------------------------------------------------------------- */
/* POST /api/v1/admin/agent-tokens                                             */
/* -------------------------------------------------------------------------- */

/**
 * 签发 Agent 服务令牌的请求体（`docs/06:37`、`docs/09:126`）。
 *
 * **强制 TOTP 二次验证**（`docs/09` §9.2：`agent:token:manage` 属高风险运营操作，
 * 明文令牌仅返回一次，一旦泄露需立即吊销）——故 `totpCode` 为**必填**。
 */
export const AdminAgentTokenIssueBodySchema = z.object({
  /** 令牌名称（便于识别与轮换），如 `piecho-prod`。 */
  name: z.string().trim().min(1, "名称不能为空").max(64, "名称过长"),
  /** 授予的 scope；一期仅四个读 scope（07 §7.8.1）。 */
  scopes: z.array(AgentScopeSchema).min(1, "至少授予一个 scope"),
  /** 有效期天数；默认 180 天（07 §7.8.1）。 */
  expiresInDays: z.coerce
    .number()
    .int("有效期须为整数天")
    .min(1, "有效期至少 1 天")
    .max(ADMIN_AGENT_TOKEN_MAX_TTL_DAYS, "有效期过长")
    .default(ADMIN_AGENT_TOKEN_DEFAULT_TTL_DAYS),
  /** 令牌级限流（次/分钟）；默认 600（07 §7.8.4）。 */
  rateLimitPerMin: z.coerce
    .number()
    .int("限流须为整数")
    .min(1, "限流至少 1 次/分钟")
    .max(100_000, "限流过大")
    .default(ADMIN_AGENT_TOKEN_DEFAULT_RATE_LIMIT_PER_MIN),
  /** 动态验证码（**必填**，`docs/09` §9.2 高风险操作二次验证）。 */
  totpCode: z.string().trim().regex(TOTP_CODE_PATTERN, "动态验证码须为 6 位数字"),
});
export type AdminAgentTokenIssueBody = z.infer<typeof AdminAgentTokenIssueBodySchema>;

/**
 * 签发成功的响应 `data`。
 *
 * ⚠️ `token`（明文）**仅此一次返回**；服务端只存 `HMAC-SHA256(pepper, token)`
 * （`docs/07` §7.8.1）。此后任何查询都无法取回明文。
 */
export const AdminAgentTokenIssueResultSchema = z.object({
  id: UlidSchema,
  name: z.string().min(1),
  tokenPrefix: z.string().min(1),
  scopes: z.array(AgentScopeSchema).min(1),
  expiresAt: IsoDateTimeSchema,
  rateLimitPerMin: z.number().int().positive(),
  /** 明文令牌（`dshop_svc_<24>_<6>`），**仅此一次**。 */
  token: z.string().min(1),
});
export type AdminAgentTokenIssueResult = z.infer<typeof AdminAgentTokenIssueResultSchema>;

/* -------------------------------------------------------------------------- */
/* POST /api/v1/admin/agent-tokens/:id/revoke                                  */
/* -------------------------------------------------------------------------- */

/** 吊销的路径参数（`docs/06:38`）。 */
export const AdminAgentTokenRevokeParamsSchema = z.object({ id: UlidSchema });
export type AdminAgentTokenRevokeParams = z.infer<typeof AdminAgentTokenRevokeParamsSchema>;

/** 吊销请求体（可选说明，落 `audit_logs.after`）。 */
export const AdminAgentTokenRevokeBodySchema = z
  .object({
    reason: z.string().trim().max(200, "说明过长").optional(),
  })
  .default({});
export type AdminAgentTokenRevokeBody = z.infer<typeof AdminAgentTokenRevokeBodySchema>;

/** 吊销成功的响应 `data`（**不返回任何凭据**）。 */
export const AdminAgentTokenRevokeResultSchema = z.object({
  id: UlidSchema,
  status: z.literal("revoked"),
  revokedAt: IsoDateTimeSchema,
});
export type AdminAgentTokenRevokeResult = z.infer<typeof AdminAgentTokenRevokeResultSchema>;

/* -------------------------------------------------------------------------- */
/* POST /api/v1/admin/aftersale-policies                                       */
/* -------------------------------------------------------------------------- */

/**
 * 维护售后政策语料的请求体（`docs/06:39`）。
 *
 * 需权限点 `aftersale:policy:manage`（`docs/09` §9.2）。
 * `content` 为 markdown 正文，PiEcho 经 `GET /api/v1/agent/policies/{category}`
 * **逐字下发**并切片入库（07 §7.7）。
 */
export const AdminAftersalePolicyCreateBodySchema = z
  .object({
    /** 政策分类（**不含 `all`**：那是查询聚合值，非存储值，见 `enums.ts`）。 */
    category: PolicyCategorySchema,
    title: z.string().trim().min(1, "标题不能为空").max(200, "标题过长"),
    /** markdown 正文。 */
    content: z.string().min(1, "正文不能为空"),
    /** 版本号，如 `1.0.0`。 */
    version: z.string().trim().min(1, "版本号不能为空").max(32, "版本号过长"),
    /** 生效起点（UTC ISO-8601）。 */
    effectiveFrom: IsoDateTimeSchema,
    /** 生效终点；`null` = 长期有效。 */
    effectiveTo: IsoDateTimeSchema.nullable().default(null),
    /** 状态；默认 `draft`（未生效的政策不会被 Agent 下发）。 */
    status: PolicyStatusSchema.default(POLICY_STATUS.DRAFT),
    /** 检索标签；默认空数组。 */
    tags: z.array(z.string().trim().min(1)).default([]),
  })
  .superRefine((value, ctx) => {
    if (value.effectiveTo !== null && value.effectiveTo <= value.effectiveFrom) {
      ctx.addIssue({
        code: "custom",
        message: "生效终点必须晚于生效起点",
        path: ["effectiveTo"],
      });
    }
  });
export type AdminAftersalePolicyCreateBody = z.infer<typeof AdminAftersalePolicyCreateBodySchema>;

/** 创建成功的响应 `data`。 */
export const AdminAftersalePolicyCreateResultSchema = z.object({
  id: UlidSchema,
  category: PolicyCategorySchema,
  title: z.string().min(1),
  version: z.string().min(1),
  status: PolicyStatusSchema,
  effectiveFrom: IsoDateTimeSchema,
  effectiveTo: IsoDateTimeSchema.nullable(),
  tags: z.array(z.string()),
});
export type AdminAftersalePolicyCreateResult = z.infer<
  typeof AdminAftersalePolicyCreateResultSchema
>;

/* -------------------------------------------------------------------------- */
/* GET /api/v1/admin/task-queue                                                */
/* -------------------------------------------------------------------------- */

/**
 * 任务死信列表查询参数（`docs/06:40`、`docs/09` §9.2）。
 *
 * ★ 分页字段**复用** `PageQuerySchema`（`./common.js`，`docs/06:21` 的三组统一分页），
 * 不在此另抄一份 `page` / `pageSize` —— 抄一份就会与三组的分页口径漂移。
 *
 * `status` 白名单**直接取 `TASK_QUEUE_STATUS`**（`../enums.js`，值域
 * `pending / processing / done / failed`），**不手抄字面量数组**：消费侧落库的
 * 完成态是 `done`（`apps/api/src/jobs/task-queue.ts` 的 `SET status = 'done'`），
 * 手抄成 `succeeded` 会让 `?status=done` 返回 400，运维把「状态名写错」误读成
 * 「已完成任务不存在」——静默功能缺失。
 */
export const AdminTaskQueueListQuerySchema = PageQuerySchema.extend({
  /** 状态过滤；**白名单枚举**，默认 `failed`（死信默认视图）。 */
  status: z
    .enum(Object.values(TASK_QUEUE_STATUS) as [TaskQueueStatus, ...TaskQueueStatus[]])
    .default(TASK_QUEUE_STATUS.FAILED),
  /** 任务类型过滤；空串（含全空白）trim 后视为**不过滤**（`?type=` 不应报错）。 */
  type: z
    .string()
    .optional()
    .transform((value) =>
      value === undefined || value.trim().length === 0 ? undefined : value.trim(),
    ),
});
export type AdminTaskQueueListQuery = z.infer<typeof AdminTaskQueueListQuerySchema>;

/**
 * 死信列表项（`GET /api/v1/admin/task-queue` 的 `list[]`）。
 *
 * ⚠️ `payload` 是**原样字符串**，契约层**不解析**：死信里本就有「payload 损坏」
 * 的行（`jobs/task-queue.ts` 的 `task_payload_invalid`），在此解析会让运维入口
 * 对最需要被看到的那批行直接 500。
 */
export const AdminTaskQueueRowSchema = z.object({
  id: UlidSchema,
  type: z.string().min(1),
  payload: z.string(),
  status: z.string().min(1),
  attempts: z.number().int().nonnegative(),
  runAt: IsoDateTimeSchema,
  lastError: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type AdminTaskQueueRow = z.infer<typeof AdminTaskQueueRowSchema>;

/**
 * `GET /api/v1/admin/task-queue` 的响应 `data`。
 *
 * ★ 形状为 `{ page, pageSize, total, list }`（`docs/06:21` 三组统一分页），
 * 经 `pageResultSchema` 产出 `list` 字段——**不是 `items`**。管理端唯一取页函数
 * `apps/admin/src/api/client.ts` 的 `getPage` 只认 `data.list`，用 `items` 会让
 * 任何页面拿到「空表格 + 非零 total」（静默丢数据）。
 */
export const AdminTaskQueueListSchema = pageResultSchema(AdminTaskQueueRowSchema);
