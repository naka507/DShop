/**
 * 后台视图类型（契约中心，零业务逻辑）。
 *
 * 字段口径来自：
 * - `docs/06-API路由命名空间.md` §6：后台组统一响应体 `{ code, message, data }`、
 *   分页统一 `{ page, pageSize, total, list }`
 * - `docs/09-认证权限与部署.md` §9.1–§9.2：登录身份与权限点
 * - `docs/M0-实施简报.md` §4.2–§4.3：订单/售后/政策/服务令牌字段
 * - `docs/05-数据模型.md` §5.2：`aftersale_policies`、`service_tokens`、商品/商户/门店
 *
 * ⚠️ 单号格式受对外契约保护，**不得放宽**（`packages/shared/src/ids.ts`）：
 * 订单号 `^DS\d{17}$`、子单号 `^DS\d{17}-\d{2}$`、售后单号 `^AS\d{11}$`。
 * 本文件只做类型声明，不做校验；校验请复用 `@dshop/shared` 的 Schema。
 */

/** 后台组统一分页载荷（shop / admin / merchant 三组共用，`docs/06` §6）。 */
export interface PageResult<T> {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly list: readonly T[];
}

/** 分页查询参数。 */
export interface PageQuery {
  readonly page?: number;
  readonly pageSize?: number;
}

/* -------------------------------------------------------------------------- */
/* 会话与身份（docs/09 §9.1）                                                  */
/* -------------------------------------------------------------------------- */

/** 登录/`me` 返回的后台主体（对齐 `apps/api` 的 `/api/v1/admin/me` 响应）。 */
export interface AdminSubject {
  readonly id: string;
  readonly username: string;
  readonly nickname: string;
  /** 令牌受众：`admin`（平台）或 `merchant`（商户）。 */
  readonly aud: string;
  /** 主角色 code。 */
  readonly role: string;
  readonly roles: readonly string[];
  /** ★ 权限点集合（`packages/shared/src/rbac.ts`），前端菜单与按钮同源渲染。 */
  readonly permissions: readonly string[];
  /** 商户身份绑定的商户 ID 列表（`merchantScope` 由后端强制，前端仅展示）。 */
  readonly merchantIds: readonly string[];
}

/** 登录接口响应。 */
export interface LoginResult {
  readonly accessToken: string;
  readonly expiresIn: number;
  readonly subject: AdminSubject;
}

/* -------------------------------------------------------------------------- */
/* Agent 服务令牌（docs/07 §7.8.1 / docs/09 §10.3 步骤 6）                      */
/* -------------------------------------------------------------------------- */

/** 令牌状态（`service_tokens.status`）。 */
export type AgentTokenStatus = "active" | "revoked";

/** 令牌列表项（**不含明文**——明文只在签发响应出现一次）。 */
export interface AgentToken {
  readonly id: string;
  readonly name: string;
  /** 明文前 16 位（`token_prefix`），用于人工核对交付对象。 */
  readonly tokenPrefix: string;
  /** 令牌 scope，一期四个读 scope。 */
  readonly scopes: readonly string[];
  readonly status: AgentTokenStatus;
  readonly rateLimitPerMin: number;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly createdBy: string | null;
}

/**
 * 签发令牌的响应。
 *
 * ★ **`token` 是明文，仅在本次响应返回一次**（`docs/07` §7.8.1 / `docs/09` §10.3 步骤 6）。
 * 服务端只存 `token_hash = HMAC-SHA256(AGENT_TOKEN_PEPPER, token)`，无法再次取出。
 */
export interface IssuedAgentToken {
  readonly token: string;
  readonly id: string;
  readonly name: string;
  readonly tokenPrefix: string;
  readonly scopes: readonly string[];
  readonly expiresAt: string;
}

/** 签发请求体（`docs/09` §10.3：`{ name, scopes, expiresIn }`）。 */
export interface IssueAgentTokenPayload {
  readonly name: string;
  readonly scopes: readonly string[];
  /** 有效期天数，默认 180（`docs/M0-实施简报` §4.3）。 */
  readonly expiresInDays: number;
  /** ★ 强制 TOTP 二次确认（`docs/09` §9.2 的 `agent:token:manage`）。 */
  readonly totpCode: string;
}

/* -------------------------------------------------------------------------- */
/* 售后政策（docs/05 §5.2 / docs/07 §7.7）                                     */
/* -------------------------------------------------------------------------- */

/** 政策分类五类（`POLICY_CATEGORY`）。 */
export type PolicyCategory = "return" | "refund" | "exchange" | "freight" | "warranty";

/** 政策状态：草稿 / 已生效（可对外）/ 已归档。 */
export type PolicyStatus = "draft" | "effective" | "archived";

/** 售后政策条款。 */
export interface AftersalePolicy {
  readonly id: string;
  readonly category: PolicyCategory;
  readonly title: string;
  /** markdown 正文（PiEcho 政策语料正文）。 */
  readonly content: string;
  readonly version: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly status: PolicyStatus;
  readonly tags: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 新建/编辑政策的请求体。 */
export interface AftersalePolicyPayload {
  readonly id?: string;
  readonly category: PolicyCategory;
  readonly title: string;
  readonly content: string;
  readonly version: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly status: PolicyStatus;
  readonly tags: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* 订单（docs/08 §8.3：主单状态 + 子单状态都要展示）                            */
/* -------------------------------------------------------------------------- */

/** 订单商品快照。 */
export interface OrderItem {
  readonly skuId: string;
  readonly title: string;
  readonly spec: Readonly<Record<string, string>>;
  readonly unitPrice: number;
  readonly quantity: number;
  readonly subtotal: number;
}

/** 物流信息。 */
export interface Express {
  readonly company: string;
  readonly companyCode: string;
  readonly no: string;
  readonly shippedAt: string | null;
  readonly latestStatus: string;
  readonly latestStatusAt: string | null;
  readonly traces: readonly { readonly time: string; readonly desc: string }[];
}

/** 子单（独立流转，`docs/08` §8.3）。 */
export interface SubOrder {
  readonly subOrderNo: string;
  readonly merchantId: string;
  readonly merchantName: string;
  readonly status: string;
  readonly statusText: string;
  readonly shipFrom: { readonly storeName: string; readonly city: string } | null;
  readonly express: Express | null;
  readonly items: readonly OrderItem[];
}

/** 订单列表项（**主单状态 + 子单状态摘要**）。 */
export interface OrderSummary {
  readonly orderNo: string;
  readonly status: string;
  readonly statusText: string;
  readonly channel: string;
  readonly payAmount: number;
  readonly currency: string;
  readonly createdAt: string;
  readonly paidAt: string | null;
  readonly subOrderCount: number;
  /** 子单状态摘要，用于列表里直接看到子单状态而不必进详情。 */
  readonly subOrderStatuses: readonly {
    readonly subOrderNo: string;
    readonly statusText: string;
  }[];
}

/** 订单详情（主单 + 全部子单）。 */
export interface OrderDetail extends OrderSummary {
  readonly receiver: {
    readonly name: string;
    readonly phone: string;
    readonly region: string;
    readonly addressMasked: string;
  };
  readonly subOrders: readonly SubOrder[];
  readonly aftersaleSummary: {
    readonly hasAftersale: boolean;
    readonly openCount: number;
    readonly refundedAmount: number;
  };
}

/* -------------------------------------------------------------------------- */
/* 售后单（docs/08 §8.4）                                                      */
/* -------------------------------------------------------------------------- */

/** 售后列表项。 */
export interface AftersaleSummary {
  readonly aftersaleNo: string;
  readonly type: string;
  readonly typeText: string;
  readonly status: string;
  readonly statusText: string;
  readonly orderNo: string;
  readonly subOrderNo: string;
  readonly itemTitle: string;
  readonly quantity: number;
  readonly refundAmount: number;
  readonly currency: string;
  readonly createdAt: string;
  readonly deadlineAt: string | null;
}

/** 售后时间线节点（`aftersale_logs`，唯一来源）。 */
export interface AftersaleTimelineNode {
  readonly time: string;
  readonly status: string;
  readonly statusText: string;
  readonly actor: string;
  readonly remark: string | null;
}

/** 售后详情。 */
export interface AftersaleDetail extends AftersaleSummary {
  readonly skuId: string;
  readonly reason: string;
  readonly evidenceCount: number;
  readonly returnAddress: {
    readonly name: string;
    readonly phone: string;
    readonly region: string;
    readonly addressMasked: string;
  } | null;
  readonly returnExpress: {
    readonly company: string;
    readonly no: string;
  } | null;
  readonly refund: {
    readonly status: string;
    readonly refundNo: string | null;
    readonly channel: string | null;
    readonly arrivedAt: string | null;
    readonly estimatedArrivalDays: number | null;
  } | null;
  readonly timeline: readonly AftersaleTimelineNode[];
}

/* -------------------------------------------------------------------------- */
/* 商品与分类（只读）                                                          */
/* -------------------------------------------------------------------------- */

/** 商品列表项（只读展示）。 */
export interface ProductSummary {
  readonly spuId: string;
  readonly title: string;
  readonly subtitle: string;
  readonly merchantId: string;
  readonly categoryId: string;
  readonly status: string;
  readonly mainImage: string | null;
  readonly minPrice: number;
  readonly maxPrice: number;
  readonly updatedAt: string;
}

/** 分类（树形，`parentId` 为 null 即根）。 */
export interface CategoryNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly level: number;
  readonly sortOrder: number;
  readonly status: string;
}

/* -------------------------------------------------------------------------- */
/* 商户与门店（只读）                                                          */
/* -------------------------------------------------------------------------- */

/** 商户（只读展示）。 */
export interface MerchantSummary {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly status: string;
  readonly contactName: string;
  readonly contactPhone: string;
  readonly createdAt: string;
}

/** 门店 / 仓库（只读展示）。 */
export interface StoreSummary {
  readonly id: string;
  readonly merchantId: string;
  readonly name: string;
  readonly type: string;
  readonly city: string;
  readonly province: string;
  readonly supportsPickup: boolean;
  readonly status: string;
}
