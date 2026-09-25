/**
 * 统一响应信封与错误响应（`docs/07` §7.1 / §7.2）。
 *
 * **信封形状由契约中心固定为 `{ code, message, data }`**（对齐 PiEcho 侧
 * `tests/contract/fixtures/*.json`）：
 * - 成功：`code = 0`，`message = "ok"`，`data` 为载荷
 * - 失败：`code = <业务错误码>`，`message = AGENT_ERROR_META[code].message`，`data = null`
 *
 * HTTP 状态码由 `httpStatusFor(code)` 映射（`40401` → 404、`40501` → 405、`42901` → 429）。
 * `requestId` **不进响应体**（fixture 无此字段），只走 `X-Request-Id` 响应头。
 */

import {
  AGENT_ERROR_CODES,
  httpStatusFor,
  messageFor,
  OK_MESSAGE,
} from "@dshop/shared";
import type { AgentErrorCode } from "@dshop/shared";

/** 成功响应信封。 */
export interface SuccessEnvelope<T> {
  readonly code: 0;
  readonly message: typeof OK_MESSAGE;
  readonly data: T;
}

/** 失败响应信封。 */
export interface ErrorEnvelope {
  readonly code: number;
  readonly message: string;
  readonly data: null;
}

/** 构造成功信封。 */
export function successEnvelope<T>(data: T): SuccessEnvelope<T> {
  return { code: AGENT_ERROR_CODES.OK, message: OK_MESSAGE, data };
}

/** 构造失败信封。 */
export function errorEnvelope(code: AgentErrorCode, message?: string): ErrorEnvelope {
  return { code, message: message ?? messageFor(code), data: null };
}

/**
 * 成功响应。
 *
 * @param extraHeaders 额外响应头（如限流头、缓存头）
 */
export function successResponse<T>(
  data: T,
  extraHeaders?: Record<string, string>,
): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "X-Contract-Version": "1",
    ...extraHeaders,
  };
  return new Response(JSON.stringify(successEnvelope(data)), { status: 200, headers });
}

/**
 * 失败响应。
 *
 * @param extraHeaders 额外响应头（如 429 的 `Retry-After`、405 的 `Allow`）
 */
export function errorResponse(
  code: AgentErrorCode,
  message?: string,
  extraHeaders?: Record<string, string>,
): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "X-Contract-Version": "1",
    ...extraHeaders,
  };
  return new Response(JSON.stringify(errorEnvelope(code, message)), {
    status: httpStatusFor(code),
    headers,
  });
}

/** 400：参数校验失败。 */
export const invalidParam = (message?: string): Response =>
  errorResponse(AGENT_ERROR_CODES.INVALID_PARAM, message);

/** 400：不支持的契约版本。 */
export const unsupportedContractVersion = (message?: string): Response =>
  errorResponse(AGENT_ERROR_CODES.UNSUPPORTED_CONTRACT_VERSION, message);

/** 401：服务令牌缺失或无效。 */
export const unauthorized = (message?: string): Response =>
  errorResponse(AGENT_ERROR_CODES.TOKEN_MISSING_OR_INVALID, message);

/** 401：令牌已吊销或已过期。 */
export const tokenRevoked = (message?: string): Response =>
  errorResponse(AGENT_ERROR_CODES.TOKEN_REVOKED, message);

/** 403：令牌 scope 不含该资源。 */
export const forbidden = (message?: string): Response =>
  errorResponse(AGENT_ERROR_CODES.SCOPE_INSUFFICIENT, message);

/** 404：订单不存在。 */
export const orderNotFound = (message?: string): Response =>
  errorResponse(AGENT_ERROR_CODES.ORDER_NOT_FOUND, message);

/** 404：商品不存在。 */
export const productNotFound = (message?: string): Response =>
  errorResponse(AGENT_ERROR_CODES.PRODUCT_NOT_FOUND, message);

/** 404：售后单不存在。 */
export const aftersaleNotFound = (message?: string): Response =>
  errorResponse(AGENT_ERROR_CODES.AFTERSALE_NOT_FOUND, message);

/** 404：政策分类无生效条款。 */
export const policyNotEffective = (message?: string): Response =>
  errorResponse(AGENT_ERROR_CODES.POLICY_NOT_EFFECTIVE, message);

/** 405：对 Agent 组使用了非 GET 方法（带 `Allow: GET`）。 */
export const methodNotAllowed = (message?: string): Response =>
  errorResponse(AGENT_ERROR_CODES.METHOD_NOT_ALLOWED, message, { Allow: "GET" });

/** 429：触发限流（带 `Retry-After`）。 */
export const rateLimited = (retryAfterSeconds: number, message?: string): Response =>
  errorResponse(AGENT_ERROR_CODES.RATE_LIMITED, message, {
    "Retry-After": String(retryAfterSeconds),
  });

/** 500：服务内部错误。 */
export const internalError = (message?: string): Response =>
  errorResponse(AGENT_ERROR_CODES.INTERNAL_ERROR, message);
