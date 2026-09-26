/**
 * 访问日志中间件（`docs/09` §9.x 可观测性）。
 *
 * 结构化 JSON 日志，字段固定便于检索：
 * `level / event / requestId / method / path / status / durationMs / tokenPrefix`
 *
 * ⚠️ **绝不记录**：令牌明文、请求体、手机号、地址等 PII。
 * 令牌只记 `token_prefix`（前 16 位，`service_tokens` 表已存该值）。
 */

import type { MiddlewareHandler } from "hono";

import type { AppEnv } from "../lib/context.js";

export const accessLog = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const start = Date.now();
  await next();
  const durationMs = Date.now() - start;

  const requestId = c.get("requestId") ?? "";
  const token = c.get("serviceToken");

  // 结构化访问日志是 Workers 运行时的唯一出口，此处有意使用 console.log（见文件头注释）
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      level: "info",
      event: "request",
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs,
      tokenPrefix: token?.tokenPrefix ?? null,
      contractVersion: c.get("contractVersion") ?? null,
    }),
  );
};
