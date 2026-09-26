/**
 * 后台组类型化调用：shop / merchant / admin（`docs/06` §6）。
 *
 * 三组的**失败码是字符串**（`ERR_<域>_<原因>`，`docs/README.md:34`），
 * 由 `decodeEnvelope` 依据路径前缀分流出 `BackofficeFailure`。
 *
 * 鉴权：浏览器走 HttpOnly Cookie（`credentials: "include"` 由调用方在 `fetch` 注入时决定），
 * 小程序 / APP 走 `Authorization: Bearer`（`docs/06:22`、`docs/03:94`）。
 *
 * ## 本模块只覆盖已冻结契约的端点
 *
 * 当前仓库已冻结的后台契约只有 `packages/shared/src/contracts/admin.ts`
 * （签发 / 吊销 Agent 令牌、发布售后政策，`docs/06:37-39`）。
 * 其余后台端点（商品、订单、结算等）契约尚未落地，**此处不臆造**——
 * 需要时用 `TypedApiClient` 的通用 `get/post/...` + 对应 Zod schema 直接调用。
 */

import {
  AdminAftersalePolicyCreateBodySchema,
  AdminAftersalePolicyCreateResultSchema,
  AdminAgentTokenIssueBodySchema,
  AdminAgentTokenIssueResultSchema,
  AdminAgentTokenRevokeBodySchema,
  AdminAgentTokenRevokeParamsSchema,
  AdminAgentTokenRevokeResultSchema,
} from "@dshop/shared";
import { z } from "zod";

import type { TypedApiClient } from "./client.js";
import type { RequestOptions } from "./client.js";
import type { Unpacked } from "./envelope.js";
import type {
  AdminAftersalePolicyCreateResult,
  AdminAgentTokenIssueResult,
  AdminAgentTokenRevokeResult,
} from "@dshop/shared";

/** `POST /admin/login` 的响应 `data`（`docs/09` §9.1）。 */
export const AdminLoginResultSchema = z.object({
  accessToken: z.string().min(1),
  expiresIn: z.number().int().positive(),
  subject: z.object({
    id: z.string().min(1),
    username: z.string().min(1),
    nickname: z.string().nullable(),
    aud: z.string().min(1),
    role: z.string().min(1),
    roles: z.array(z.string()),
    permissions: z.array(z.string()),
    merchantIds: z.array(z.string()),
  }),
});
export type AdminLoginResult = z.infer<typeof AdminLoginResultSchema>;

/** `POST /admin/refresh` 的响应 `data`。 */
export const AdminRefreshResultSchema = z.object({
  refreshToken: z.string().min(1),
  expiresIn: z.number().int().positive(),
});
export type AdminRefreshResult = z.infer<typeof AdminRefreshResultSchema>;

/** `POST /admin/logout` 的响应 `data`。 */
export const AdminLogoutResultSchema = z.object({ loggedOut: z.boolean() });
export type AdminLogoutResult = z.infer<typeof AdminLogoutResultSchema>;

/** 平台后台类型化调用集合。 */
export class AdminApi {
  private readonly client: TypedApiClient<"admin">;

  constructor(client: TypedApiClient<"admin">) {
    this.client = client;
  }

  /** `POST /login` —— 账号密码（可选 TOTP）登录（`docs/09` §9.1）。 */
  login(
    body: { readonly username: string; readonly password: string; readonly totpCode?: string },
    options?: RequestOptions,
  ): Promise<Unpacked<AdminLoginResult>> {
    return this.client.post("/login", AdminLoginResultSchema, { ...options, body });
  }

  /** `POST /refresh` —— 旋转式刷新。 */
  refresh(options?: RequestOptions): Promise<Unpacked<AdminRefreshResult>> {
    return this.client.post("/refresh", AdminRefreshResultSchema, options);
  }

  /** `POST /logout` —— 吊销 refresh 并清 Cookie。 */
  logout(options?: RequestOptions): Promise<Unpacked<AdminLogoutResult>> {
    return this.client.post("/logout", AdminLogoutResultSchema, options);
  }

  /**
   * `POST /agent-tokens` —— 签发 PiEcho 服务令牌（`docs/06:37`）。
   *
   * 需权限点 `agent:token:manage`；`totpCode` **必填**（`docs/09` §9.2 高风险操作）。
   * 明文令牌**仅此一次返回**（`docs/07` §7.8.1）。
   */
  issueAgentToken(
    body: unknown,
    options?: RequestOptions,
  ): Promise<Unpacked<AdminAgentTokenIssueResult>> {
    return this.client.post("/agent-tokens", AdminAgentTokenIssueResultSchema, {
      ...options,
      body: AdminAgentTokenIssueBodySchema.parse(body),
    });
  }

  /** `POST /agent-tokens/{id}/revoke` —— 立即吊销（`docs/06:38`）。 */
  revokeAgentToken(
    id: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<Unpacked<AdminAgentTokenRevokeResult>> {
    const params = AdminAgentTokenRevokeParamsSchema.parse({ id });
    return this.client.post(
      `/agent-tokens/${encodeURIComponent(params.id)}/revoke`,
      AdminAgentTokenRevokeResultSchema,
      { ...options, body: AdminAgentTokenRevokeBodySchema.parse(body ?? {}) },
    );
  }

  /**
   * `POST /aftersale-policies` —— 发布售后政策（`docs/06:39`）。
   *
   * 需权限点 `aftersale:policy:manage`；发布后**主动失效** `/policies/*` 边缘缓存
   * （`docs/07:320`）。
   */
  createAftersalePolicy(
    body: unknown,
    options?: RequestOptions,
  ): Promise<Unpacked<AdminAftersalePolicyCreateResult>> {
    return this.client.post("/aftersale-policies", AdminAftersalePolicyCreateResultSchema, {
      ...options,
      body: AdminAftersalePolicyCreateBodySchema.parse(body),
    });
  }
}

/**
 * 商户后台类型化调用集合。
 *
 * 商户端契约尚未冻结（`packages/shared` 无 `contracts/merchant.ts`），
 * 故仅暴露**类型化通用调用入口**，不臆造端点签名。
 */
export class MerchantApi {
  readonly client: TypedApiClient<"merchant">;

  constructor(client: TypedApiClient<"merchant">) {
    this.client = client;
  }
}

/**
 * C 端商城类型化调用集合。
 *
 * C 端契约尚未冻结（`packages/shared` 无 `contracts/shop.ts`），
 * 故仅暴露**类型化通用调用入口**，不臆造端点签名。
 */
export class ShopApi {
  readonly client: TypedApiClient<"shop">;

  constructor(client: TypedApiClient<"shop">) {
    this.client = client;
  }
}
