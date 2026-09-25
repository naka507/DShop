/**
 * Agent API 统一错误码（契约中心，零业务逻辑）。
 *
 * 权威来源：`docs/07-Agent-API契约.md` §7.1「统一错误码表（Agent 组）」。
 * 14 项含成功码 `0`，**逐字照录**，不做增删。
 *
 * ⚠️ 这些码与 PiEcho 侧 `ESHOP_ERROR_CODES` 是**同一套**（PiEcho 照抄 DShop 契约）。
 * 任何改动必须两侧同步——本文件是权威定义方。
 */

import { z } from "zod";

/** 错误码元信息。 */
export interface ErrorCodeMeta {
  /** HTTP 状态码。 */
  readonly http: number;
  /** 语义（中文，取自 07 §7.1 表格）。 */
  readonly message: string;
}

export const AGENT_ERROR_CODES = {
  /** 200 成功。 */
  OK: 0,
  /** 400 参数校验失败（缺参 / 类型错 / 越界）。 */
  INVALID_PARAM: 40001,
  /** 400 显式提供了不受支持的 `X-Contract-Version`（**缺失不报此错**）。 */
  UNSUPPORTED_CONTRACT_VERSION: 40010,
  /** 401 服务令牌缺失或无效。 */
  TOKEN_MISSING_OR_INVALID: 40101,
  /** 401 服务令牌已吊销或已过期。 */
  TOKEN_REVOKED: 40102,
  /** 403 令牌 scope 不含该资源。 */
  SCOPE_INSUFFICIENT: 40301,
  /** 404 订单不存在。 */
  ORDER_NOT_FOUND: 40401,
  /** 404 商品不存在或已删除。 */
  PRODUCT_NOT_FOUND: 40402,
  /** 404 售后单不存在。 */
  AFTERSALE_NOT_FOUND: 40403,
  /** 404 政策分类无生效条款。 */
  POLICY_NOT_EFFECTIVE: 40404,
  /** 405 对 Agent 组使用了非 GET 方法。 */
  METHOD_NOT_ALLOWED: 40501,
  /** 409 受控写幂等冲突或状态不允许。 */
  IDEMPOTENCY_CONFLICT: 40901,
  /** 429 触发限流。 */
  RATE_LIMITED: 42901,
  /** 500 服务内部错误。 */
  INTERNAL_ERROR: 50001,
} as const;

export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[keyof typeof AGENT_ERROR_CODES];

/** 错误码元信息表（HTTP 状态与语义）。 */
export const AGENT_ERROR_META: Record<AgentErrorCode, ErrorCodeMeta> = {
  [AGENT_ERROR_CODES.OK]: { http: 200, message: "成功" },
  [AGENT_ERROR_CODES.INVALID_PARAM]: { http: 400, message: "参数校验失败" },
  [AGENT_ERROR_CODES.UNSUPPORTED_CONTRACT_VERSION]: {
    http: 400,
    message: "不支持的契约版本",
  },
  [AGENT_ERROR_CODES.TOKEN_MISSING_OR_INVALID]: {
    http: 401,
    message: "服务令牌缺失或无效",
  },
  [AGENT_ERROR_CODES.TOKEN_REVOKED]: {
    http: 401,
    message: "服务令牌已吊销或已过期",
  },
  [AGENT_ERROR_CODES.SCOPE_INSUFFICIENT]: {
    http: 403,
    message: "令牌 scope 不含该资源",
  },
  [AGENT_ERROR_CODES.ORDER_NOT_FOUND]: { http: 404, message: "订单不存在" },
  [AGENT_ERROR_CODES.PRODUCT_NOT_FOUND]: {
    http: 404,
    message: "商品不存在或已删除",
  },
  [AGENT_ERROR_CODES.AFTERSALE_NOT_FOUND]: {
    http: 404,
    message: "售后单不存在",
  },
  [AGENT_ERROR_CODES.POLICY_NOT_EFFECTIVE]: {
    http: 404,
    message: "政策分类无生效条款",
  },
  [AGENT_ERROR_CODES.METHOD_NOT_ALLOWED]: {
    http: 405,
    message: "对 Agent 组使用了非 GET 方法",
  },
  [AGENT_ERROR_CODES.IDEMPOTENCY_CONFLICT]: {
    http: 409,
    message: "受控写幂等冲突或状态不允许",
  },
  [AGENT_ERROR_CODES.RATE_LIMITED]: { http: 429, message: "触发限流" },
  [AGENT_ERROR_CODES.INTERNAL_ERROR]: {
    http: 500,
    message: "服务内部错误",
  },
};

/** 错误码 Zod enum（用于响应体校验）。 */
export const AgentErrorCodeSchema = z.enum(AGENT_ERROR_CODES);

/** 取错误码对应的 HTTP 状态；未知码返回 `500`。 */
export function httpStatusFor(code: number): number {
  return AGENT_ERROR_META[code as AgentErrorCode]?.http ?? 500;
}

/** 取错误码的语义文本；未知码返回「未知错误」。 */
export function messageFor(code: number): string {
  return AGENT_ERROR_META[code as AgentErrorCode]?.message ?? "未知错误";
}

/**
 * 统一响应体 `{ code, message, data }`。
 *
 * `code` 为整数，`0` 表示成功（07 §7.1）。成功时 `message` 为 `"ok"`（07 fixture 口径），
 * 失败时为 `AGENT_ERROR_META[code].message`。
 */
export const AgentEnvelopeSchema = z.object({
  code: AgentErrorCodeSchema,
  message: z.string(),
  data: z.unknown(),
});
export type AgentEnvelope = z.infer<typeof AgentEnvelopeSchema>;

/** 成功响应 `message` 常量（07 fixture 全部为 `"ok"`）。 */
export const OK_MESSAGE = "ok" as const;
