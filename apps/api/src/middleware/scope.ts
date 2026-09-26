/**
 * scope 校验中间件（`docs/07` §7.8.1 / `docs/05` `service_tokens.scopes`）。
 *
 * 每个 Agent 端点要求一个读 scope：
 * - `/orders*`           → `agent:order:read`
 * - `/products/{spuId}/specs`  → `agent:product:read`
 * - `/products/{spuId}/stock`  → `agent:product:read`
 * - `/aftersales/*`      → `agent:aftersale:read`
 * - `/policies/*`        → `agent:policy:read`
 *
 * 令牌 scope 不含所需权限 → `403` + `40301`。
 */

import type { AgentScope } from "@dshop/shared";
import type { MiddlewareHandler } from "hono";

import type { AppEnv } from "../lib/context.js";
import { forbidden } from "../lib/errors.js";

/** 要求指定 scope。 */
export const requireScope =
  (scope: AgentScope): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const token = c.get("serviceToken");
    if (token === undefined) {
      // 前置认证中间件未跑（编排错误），按未授权处理而非放行
      return forbidden("服务令牌缺少所需权限");
    }
    if (!token.scopes.includes(scope)) {
      return forbidden(`服务令牌缺少所需权限：${scope}`);
    }
    await next();
  };
