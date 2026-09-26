/**
 * shop 组错误响应辅助（`docs/06` §6、`docs/README.md:34`）。
 *
 * ⚠️ **shop 属后台组，错误码是字符串**（`ERR_SHOP_*`），与 Agent 组的整数码
 * 严格分离。本文件是 shop 路由层取错误码的**唯一入口**：所有码值都从
 * `@dshop/shared` 的 `SHOP_ERROR_CODES` 取，路由里**不出现任何字符串字面量**。
 */

import { SHOP_ERROR_CODES } from "@dshop/shared";
import type { BackofficeErrorTable } from "@dshop/shared";

import { backofficeErrorResponse } from "../../lib/errors.js";

/** shop 组错误码表（结构与 `BackofficeErrorTable` 一致，可按键取值）。 */
export const SHOP_CODES: BackofficeErrorTable & Record<string, string> = SHOP_ERROR_CODES;

/**
 * 构造 shop 组失败响应。
 *
 * @param key `SHOP_ERROR_CODES` 的键（如 `STOCK_INSUFFICIENT`）
 * @param message 覆盖默认语义文本（可选）
 */
export function shopError(key: keyof typeof SHOP_ERROR_CODES, message?: string): Response {
  return backofficeErrorResponse(SHOP_ERROR_CODES[key], message);
}

/** 400：参数校验失败。 */
export const shopInvalidParam = (message?: string): Response => shopError("INVALID_PARAM", message);

/** 401：未登录（`GET /shop/auth/me` 等受保护端点的统一码）。 */
export const shopUnauthorized = (message?: string): Response => shopError("UNAUTHORIZED", message);

/** 404：资源不存在（未指明具体资源时的兜底）。 */
export const shopNotFound = (message?: string): Response => shopError("NOT_FOUND", message);

/** 500：服务内部错误。 */
export const shopInternalError = (message?: string): Response =>
  shopError("INTERNAL_ERROR", message);
