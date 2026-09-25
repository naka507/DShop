/**
 * `requestId` 中间件（`docs/07` §7.2）。
 *
 * 每个请求生成 ULID 作为 `requestId`：
 * - 写入上下文，供日志与错误信封使用
 * - 回写响应头 `X-Request-Id`
 * - 若调用方已带 `X-Request-Id`（便于端到端串联），沿用之
 */

import { newId } from "@dshop/shared";
import type { MiddlewareHandler } from "hono";

import type { AppEnv } from "../lib/context.js";

/** 请求 ID 头名。 */
export const REQUEST_ID_HEADER = "X-Request-Id";

export const requestId = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const incoming = c.req.header(REQUEST_ID_HEADER);
  const id =
    incoming !== undefined && incoming.trim().length > 0 ? incoming.trim() : newId();
  c.set("requestId", id);
  await next();
  // 确保所有响应（含错误）都带 requestId
  if (!c.res.headers.has(REQUEST_ID_HEADER)) {
    c.res.headers.set(REQUEST_ID_HEADER, id);
  }
};
