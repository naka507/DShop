/**
 * 统一响应信封与错误响应（`docs/07` §7.1 / §7.2）。
 *
 * **信封形状由契约中心固定为 `{ code, message, data }`**（对齐 PiEcho 侧
 * `tests/contract/fixtures/*.json`）：
 * - 成功：`code = 0`，`message = "ok"`，`data` 为载荷
 * - 失败：`code = <业务错误码>`，`message = <语义>`，`data = null`
 *
 * ## 两套错误码（`docs/README.md:34` / `docs/06-API路由命名空间.md:20`）
 *
 * | 路由组 | 码型 | 构造器 | HTTP 映射 |
 * | --- | --- | --- | --- |
 * | `/api/v1/agent/*` | **整数**（`40001`…） | `errorResponse()` | `httpStatusFor()` |
 * | shop / admin / merchant | **字符串**（`ERR_ADMIN_*`…） | `backofficeErrorResponse()` | `backofficeHttpStatusFor()` |
 *
 * 两组**严禁混用**（`docs/README.md:34`）。`requestId` **不进响应体**（fixture 无此字段），
 * 只走 `X-Request-Id` 响应头。
 */

import {
  AGENT_ERROR_CODES,
  backofficeErrorCodesForPath,
  backofficeHttpStatusFor,
  backofficeMessageFor,
  httpStatusFor,
  messageFor,
  OK_MESSAGE,
} from "@dshop/shared";
import type { AgentErrorCode, BackofficeErrorTable } from "@dshop/shared";

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
export function successResponse<T>(data: T, extraHeaders?: Record<string, string>): Response {
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

/**
 * 后台组失败响应信封（`docs/README.md:34` / `docs/06:20`）。
 *
 * 与 Agent 组的 `errorResponse()` **分属两套**：
 * - Agent 组：整数码（`AGENT_ERROR_CODES`），HTTP 状态由 `httpStatusFor()` 映射
 * - 后台组：字符串码（`ADMIN_/SHOP_/MERCHANT_ERROR_CODES`），状态由
 *   `backofficeHttpStatusFor()` 映射
 *
 * 成功信封两组共用 `{ code: 0, message: "ok", data }`（`docs/06:18`）。
 */
export function backofficeErrorResponse(
  code: string,
  message?: string,
  extraHeaders?: Record<string, string>,
): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "X-Contract-Version": "1",
    ...extraHeaders,
  };
  const body = {
    code,
    message: message ?? backofficeMessageFor(code),
    data: null,
  };
  return new Response(JSON.stringify(body), {
    status: backofficeHttpStatusFor(code),
    headers,
  });
}

/**
 * 按**请求路径**取该后台域的错误码表，再构造失败响应。
 *
 * 供跨三组共用的中间件（`requireAdminAuth` / `requirePermission` 等）使用：
 * 中间件不知道自己挂在哪个命名空间下，只能从 `c.req.path` 推断
 * （`docs/06:11-13` 的三组前缀）。
 */
export function backofficeErrorForPath(
  path: string,
  key: keyof BackofficeErrorTable,
  message?: string,
): Response {
  const table = backofficeErrorCodesForPath(path);
  return backofficeErrorResponse(table[key], message);
}
