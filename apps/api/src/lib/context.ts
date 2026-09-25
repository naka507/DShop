/**
 * 中间件链的上下文类型（`docs/07` §7.2 / `docs/03` §3.1）。
 *
 * Hono 的 `Variables` 类型：中间件写入、路由读取。
 */

import type { ServiceTokenRecord } from "../repositories/service-tokens.js";

export interface AppVariables {
  /** 请求 ID（ULID），贯穿日志与响应。 */
  requestId: string;
  /** 生效的契约版本（默认 `1`）。 */
  contractVersion: string;
  /** 已认证的服务令牌记录（Agent 组）。 */
  serviceToken: ServiceTokenRecord;
  /** 已认证的后台主体（后台组）。 */
  adminSubject: AdminSubject;
  /** 命中路径的端点模板（限流与日志用）。 */
  endpointTemplate: string;
}

/** 后台登录主体（JWT 载荷）。 */
export interface AdminSubject {
  readonly sub: string;
  readonly aud: "shop" | "admin" | "merchant";
  readonly role: string;
  readonly mid?: string;
  readonly jti?: string;
}

/** Hono 的变量映射类型。 */
export type AppEnv = {
  Variables: AppVariables;
};
