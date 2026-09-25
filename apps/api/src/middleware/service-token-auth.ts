/**
 * 服务令牌认证中间件（`docs/07` §7.8.1）。
 *
 * 仅作用于 `/api/v1/agent/*` 组：
 * 1. 取 `X-Service-Token` 头；缺失 → 401 + `40101`
 * 2. 格式不符 → 401 + `40101`（不查库，省一次 D1 读）
 * 3. 查库 + 常量时间比对；失败按原因区分 `40101`（无效）/ `40102`（吊销或过期）
 * 4. 成功则写入上下文，并异步刷新 `last_used_at`
 *
 * 可选加固：`settings.agent_require_signature = true` 时校验请求签名（M0 默认关闭）。
 */

import { isServiceTokenFormat } from "@dshop/auth";
import type { MiddlewareHandler } from "hono";

import type { Env } from "../env.js";
import type { AppEnv } from "../lib/context.js";
import { tokenRevoked, unauthorized } from "../lib/errors.js";
import { authenticateServiceToken, touchServiceToken } from "../repositories/service-tokens.js";

/** 服务令牌头名（**非** `Authorization: Bearer`）。 */
export const SERVICE_TOKEN_HEADER = "X-Service-Token";

export const serviceTokenAuth = (): MiddlewareHandler<AppEnv & { Bindings: Env }> => async (
  c,
  next,
) => {
  const raw = c.req.header(SERVICE_TOKEN_HEADER);
  if (raw === undefined || raw.trim().length === 0) {
    return unauthorized("缺少 X-Service-Token 请求头");
  }
  const token = raw.trim();

  // 格式预检：不符合 `dshop_svc_<24>_<6>` 直接拒绝，避免无谓的 D1 读
  if (!isServiceTokenFormat(token)) {
    return unauthorized("服务令牌格式无效");
  }

  const result = await authenticateServiceToken(
    c.env.DB,
    c.env.AGENT_TOKEN_PEPPER,
    token,
  );

  if (!result.ok || result.token === undefined) {
    if (result.failure === "revoked" || result.failure === "expired") {
      return tokenRevoked(
        result.failure === "expired" ? "服务令牌已过期" : "服务令牌已吊销",
      );
    }
    return unauthorized("服务令牌无效");
  }

  c.set("serviceToken", result.token);

  // 异步刷新 last_used_at（不阻塞响应；失败仅告警）
  const nowIso = new Date().toISOString();
  const task = touchServiceToken(c.env.DB, result.token.id, nowIso);
  if (typeof c.executionCtx?.waitUntil === "function") {
    c.executionCtx.waitUntil(task);
  } else {
    await task;
  }

  await next();
};
