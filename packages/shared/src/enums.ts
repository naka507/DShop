/**
 * 枚举中心（契约中心，零业务逻辑）。
 *
 * 权威来源：`docs/05-数据模型.md` §5.2、`docs/07-Agent-API契约.md` §7.2–§7.6。
 * 每个枚举的取值**逐字照录**文档，不做增删；文档未定义的枚举在文件末尾单独标注。
 */

import { z } from "zod";

/* -------------------------------------------------------------------------- */
/* 订单与子单（05 §5.2 / 08 §8.3）                                             */
/* -------------------------------------------------------------------------- */

/**
 * 主单状态。**由子单聚合得出，不单独维护**（08 §8.3 聚合优先级见 `aggregateOrderStatus`）。
 */
export const ORDER_STATUS = {
  PENDING_PAYMENT: "PENDING_PAYMENT",
  PAID: "PAID",
  SHIPPED: "SHIPPED",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
} as const;
export type OrderStatus = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS];
export const OrderStatusSchema = z.enum(ORDER_STATUS);

/** 子单状态（独立流转）。 */
export const SUB_ORDER_STATUS = {
  PAID: "PAID",
  SHIPPED: "SHIPPED",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
} as const;
export type SubOrderStatus = (typeof SUB_ORDER_STATUS)[keyof typeof SUB_ORDER_STATUS];
export const SubOrderStatusSchema = z.enum(SUB_ORDER_STATUS);

/** 下单渠道（`orders.channel`）。 */
export const ORDER_CHANNEL = {
  WEB: "web",
  MINIPROGRAM: "miniprogram",
  APP: "app",
} as const;
export type OrderChannel = (typeof ORDER_CHANNEL)[keyof typeof ORDER_CHANNEL];
export const OrderChannelSchema = z.enum(ORDER_CHANNEL);

/** 主单状态 → 中文文案（07 §7.2 示例 `statusText`）。 */
export const ORDER_STATUS_TEXT: Record<OrderStatus, string> = {
  [ORDER_STATUS.PENDING_PAYMENT]: "待支付",
  [ORDER_STATUS.PAID]: "已支付",
  [ORDER_STATUS.SHIPPED]: "已发货",
  [ORDER_STATUS.COMPLETED]: "已完成",
  [ORDER_STATUS.CANCELLED]: "已取消",
};

/**
 * 子单状态 → 中文文案（07 §7.2 示例）。
 *
 * 注意 `PAID` 的文案是「待发货」——08 §12.3 的 `PENDING_DISPATCH`(仓库配货中)
 * 映射到子单 `PAID`，`statusText` 保留「待发货」语义。
 */
export const SUB_ORDER_STATUS_TEXT: Record<SubOrderStatus, string> = {
  [SUB_ORDER_STATUS.PAID]: "待发货",
  [SUB_ORDER_STATUS.SHIPPED]: "已发货",
  [SUB_ORDER_STATUS.COMPLETED]: "已签收",
  [SUB_ORDER_STATUS.CANCELLED]: "已取消",
};

/* -------------------------------------------------------------------------- */
/* 售后（05 §5.2 / 07 §7.5 / 08 §8.4）                                        */
/* -------------------------------------------------------------------------- */

/** 售后类型。 */
export const AFTERSALE_TYPE = {
  REFUND_ONLY: "refund_only",
  RETURN_REFUND: "return_refund",
} as const;
export type AftersaleType = (typeof AFTERSALE_TYPE)[keyof typeof AFTERSALE_TYPE];
export const AftersaleTypeSchema = z.enum(AFTERSALE_TYPE);

export const AFTERSALE_TYPE_TEXT: Record<AftersaleType, string> = {
  [AFTERSALE_TYPE.REFUND_ONLY]: "仅退款",
  [AFTERSALE_TYPE.RETURN_REFUND]: "退货退款",
};

/** 售后状态机（08 §8.4 流转顺序即此顺序）。 */
export const AFTERSALE_STATUS = {
  PENDING_MERCHANT: "PENDING_MERCHANT",
  WAIT_BUYER_RETURN: "WAIT_BUYER_RETURN",
  BUYER_RETURNED: "BUYER_RETURNED",
  MERCHANT_RECEIVED: "MERCHANT_RECEIVED",
  REFUNDING: "REFUNDING",
  REFUNDED: "REFUNDED",
  REJECTED: "REJECTED",
  CANCELLED: "CANCELLED",
} as const;
export type AftersaleStatus = (typeof AFTERSALE_STATUS)[keyof typeof AFTERSALE_STATUS];
export const AftersaleStatusSchema = z.enum(AFTERSALE_STATUS);

export const AFTERSALE_STATUS_TEXT: Record<AftersaleStatus, string> = {
  [AFTERSALE_STATUS.PENDING_MERCHANT]: "待商家处理",
  [AFTERSALE_STATUS.WAIT_BUYER_RETURN]: "待买家回寄",
  [AFTERSALE_STATUS.BUYER_RETURNED]: "买家已回寄",
  [AFTERSALE_STATUS.MERCHANT_RECEIVED]: "商家已收货",
  [AFTERSALE_STATUS.REFUNDING]: "退款中",
  [AFTERSALE_STATUS.REFUNDED]: "已退款",
  [AFTERSALE_STATUS.REJECTED]: "已驳回",
  [AFTERSALE_STATUS.CANCELLED]: "已取消",
};

/** 未终结的售后状态（`aftersaleSummary.openCount` 与 `hasOpenAftersale` 的判据）。 */
export const OPEN_AFTERSALE_STATUSES: readonly AftersaleStatus[] = [
  AFTERSALE_STATUS.PENDING_MERCHANT,
  AFTERSALE_STATUS.WAIT_BUYER_RETURN,
  AFTERSALE_STATUS.BUYER_RETURNED,
  AFTERSALE_STATUS.MERCHANT_RECEIVED,
  AFTERSALE_STATUS.REFUNDING,
];

/** 售后时间线操作者（`aftersale_logs.actor` / 07 §7.5 `timeline[].actor`）。 */
export const AFTERSALE_ACTOR = {
  BUYER: "buyer",
  MERCHANT: "merchant",
  PLATFORM: "platform",
  SYSTEM: "system",
} as const;
export type AftersaleActor = (typeof AFTERSALE_ACTOR)[keyof typeof AFTERSALE_ACTOR];
export const AftersaleActorSchema = z.enum(AFTERSALE_ACTOR);

/* -------------------------------------------------------------------------- */
/* 售后政策（05 §5.2 / 07 §7.6）                                               */
/* -------------------------------------------------------------------------- */

/** 政策分类（`aftersale_policies.category`）。 */
export const POLICY_CATEGORY = {
  RETURN: "return",
  REFUND: "refund",
  EXCHANGE: "exchange",
  FREIGHT: "freight",
  WARRANTY: "warranty",
} as const;
export type PolicyCategory = (typeof POLICY_CATEGORY)[keyof typeof POLICY_CATEGORY];
export const PolicyCategorySchema = z.enum(POLICY_CATEGORY);

/**
 * 政策查询允许的分类取值 = 五类 + `all`。
 *
 * `all` 仅作为 `/policies/{category}` 的**查询聚合值**，不是 `aftersale_policies.category`
 * 的合法存储值（07 §7.6 路径参数 `category` 支持 `all`）。
 */
export const POLICY_QUERY_CATEGORY = { ...POLICY_CATEGORY, ALL: "all" } as const;
export type PolicyQueryCategory =
  (typeof POLICY_QUERY_CATEGORY)[keyof typeof POLICY_QUERY_CATEGORY];
export const PolicyQueryCategorySchema = z.enum(POLICY_QUERY_CATEGORY);

/** 政策状态。 */
export const POLICY_STATUS = {
  DRAFT: "draft",
  EFFECTIVE: "effective",
  ARCHIVED: "archived",
} as const;
export type PolicyStatus = (typeof POLICY_STATUS)[keyof typeof POLICY_STATUS];
export const PolicyStatusSchema = z.enum(POLICY_STATUS);

/* -------------------------------------------------------------------------- */
/* 商品（05 §5.2）                                                             */
/* -------------------------------------------------------------------------- */

export const PRODUCT_STATUS = {
  DRAFT: "draft",
  PENDING_REVIEW: "pending_review",
  ONSALE: "onsale",
  OFFSALE: "offsale",
  REJECTED: "rejected",
} as const;
export type ProductStatus = (typeof PRODUCT_STATUS)[keyof typeof PRODUCT_STATUS];
export const ProductStatusSchema = z.enum(PRODUCT_STATUS);

export const SKU_STATUS = {
  ACTIVE: "active",
  INACTIVE: "inactive",
} as const;
export type SkuStatus = (typeof SKU_STATUS)[keyof typeof SKU_STATUS];
export const SkuStatusSchema = z.enum(SKU_STATUS);

/* -------------------------------------------------------------------------- */
/* 商户与门店（05 §5.2）                                                       */
/* -------------------------------------------------------------------------- */

/** 商户类型。`self`=自营、`vendor`=入驻、`branch`=分店。 */
export const MERCHANT_TYPE = {
  SELF: "self",
  VENDOR: "vendor",
  BRANCH: "branch",
} as const;
export type MerchantType = (typeof MERCHANT_TYPE)[keyof typeof MERCHANT_TYPE];
export const MerchantTypeSchema = z.enum(MERCHANT_TYPE);

export const MERCHANT_STATUS = {
  PENDING: "pending",
  APPROVED: "approved",
  SUSPENDED: "suspended",
  REJECTED: "rejected",
} as const;
export type MerchantStatus = (typeof MERCHANT_STATUS)[keyof typeof MERCHANT_STATUS];
export const MerchantStatusSchema = z.enum(MERCHANT_STATUS);

/** 门店类型。`warehouse`=仓、`store`=门店。 */
export const STORE_TYPE = {
  WAREHOUSE: "warehouse",
  STORE: "store",
} as const;
export type StoreType = (typeof STORE_TYPE)[keyof typeof STORE_TYPE];
export const StoreTypeSchema = z.enum(STORE_TYPE);

/* -------------------------------------------------------------------------- */
/* 支付与结算（05 §5.2）                                                       */
/* -------------------------------------------------------------------------- */

export const PAYMENT_CHANNEL = {
  WECHAT: "wechat",
  ALIPAY: "alipay",
} as const;
export type PaymentChannel = (typeof PAYMENT_CHANNEL)[keyof typeof PAYMENT_CHANNEL];
export const PaymentChannelSchema = z.enum(PAYMENT_CHANNEL);

export const SETTLEMENT_STATUS = {
  PENDING: "pending",
  CONFIRMED: "confirmed",
  PAID: "paid",
} as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUS)[keyof typeof SETTLEMENT_STATUS];
export const SettlementStatusSchema = z.enum(SETTLEMENT_STATUS);

/* -------------------------------------------------------------------------- */
/* 账号、RBAC 与令牌（05 §5.2 / 09 §9.2）                                      */
/* -------------------------------------------------------------------------- */

/** 角色作用域（`roles.scope`）。 */
export const ROLE_SCOPE = {
  PLATFORM: "platform",
  MERCHANT: "merchant",
} as const;
export type RoleScope = (typeof ROLE_SCOPE)[keyof typeof ROLE_SCOPE];
export const RoleScopeSchema = z.enum(ROLE_SCOPE);

/** 商户成员角色（`merchant_members.role`）。 */
export const MERCHANT_MEMBER_ROLE = {
  OWNER: "owner",
  MANAGER: "manager",
  STAFF: "staff",
} as const;
export type MerchantMemberRole = (typeof MERCHANT_MEMBER_ROLE)[keyof typeof MERCHANT_MEMBER_ROLE];
export const MerchantMemberRoleSchema = z.enum(MERCHANT_MEMBER_ROLE);

/** 服务令牌状态（`service_tokens.status`）。 */
export const SERVICE_TOKEN_STATUS = {
  ACTIVE: "active",
  REVOKED: "revoked",
} as const;
export type ServiceTokenStatus = (typeof SERVICE_TOKEN_STATUS)[keyof typeof SERVICE_TOKEN_STATUS];
export const ServiceTokenStatusSchema = z.enum(SERVICE_TOKEN_STATUS);

/** 服务令牌 scope（07 §7.8.1）。一期仅四个**读** scope；写 scope 二期启用。 */
export const AGENT_SCOPE = {
  ORDER_READ: "agent:order:read",
  PRODUCT_READ: "agent:product:read",
  AFTERSALE_READ: "agent:aftersale:read",
  POLICY_READ: "agent:policy:read",
} as const;
export type AgentScope = (typeof AGENT_SCOPE)[keyof typeof AGENT_SCOPE];
export const AgentScopeSchema = z.enum(AGENT_SCOPE);

/** 二期写 scope（一期不签发；07 §7.12 / Q5 已定案一期不启用）。 */
export const AGENT_WRITE_SCOPE = {
  ORDER_WRITE: "agent:order:write",
  AFTERSALE_WRITE: "agent:aftersale:write",
} as const;
export type AgentWriteScope = (typeof AGENT_WRITE_SCOPE)[keyof typeof AGENT_WRITE_SCOPE];

/** JWT 受众（`aud`）三取值，四套体系互不通用（09 §9.1）。 */
export const JWT_AUDIENCE = {
  SHOP: "shop",
  ADMIN: "admin",
  MERCHANT: "merchant",
} as const;
export type JwtAudience = (typeof JWT_AUDIENCE)[keyof typeof JWT_AUDIENCE];
export const JwtAudienceSchema = z.enum(JWT_AUDIENCE);

/* -------------------------------------------------------------------------- */
/* 支撑表（05 §5.2）                                                           */
/* -------------------------------------------------------------------------- */

export const TASK_QUEUE_STATUS = {
  PENDING: "pending",
  PROCESSING: "processing",
  DONE: "done",
  FAILED: "failed",
} as const;
export type TaskQueueStatus = (typeof TASK_QUEUE_STATUS)[keyof typeof TASK_QUEUE_STATUS];
export const TaskQueueStatusSchema = z.enum(TASK_QUEUE_STATUS);

export const USER_COUPON_STATUS = {
  UNUSED: "unused",
  USED: "used",
  EXPIRED: "expired",
} as const;
export type UserCouponStatus = (typeof USER_COUPON_STATUS)[keyof typeof USER_COUPON_STATUS];
export const UserCouponStatusSchema = z.enum(USER_COUPON_STATUS);

/* -------------------------------------------------------------------------- */
/* 文档未定义、由实现侧补充的枚举（见 README「文档未定义项」）                  */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ **文档未定义**：`payments.status` 与 `refunds.status` 的枚举值在
 * 05 §5.2 与 07 §7.x 中均未给出；07 §7.5 fixture 的 `refund.status` 示例值为 `"PENDING"`。
 * 此处按该示例补齐，并保持全大写风格。
 */
export const PAYMENT_STATUS = {
  PENDING: "PENDING",
  PAID: "PAID",
  FAILED: "FAILED",
  CLOSED: "CLOSED",
} as const;
export type PaymentStatus = (typeof PAYMENT_STATUS)[keyof typeof PAYMENT_STATUS];
export const PaymentStatusSchema = z.enum(PAYMENT_STATUS);

/** ⚠️ **文档未定义**（同上）。07 §7.5 fixture 示例值为 `"PENDING"`。 */
export const REFUND_STATUS = {
  PENDING: "PENDING",
  SUCCESS: "SUCCESS",
  FAILED: "FAILED",
  CLOSED: "CLOSED",
} as const;
export type RefundStatus = (typeof REFUND_STATUS)[keyof typeof REFUND_STATUS];
export const RefundStatusSchema = z.enum(REFUND_STATUS);

/**
 * ⚠️ **文档未定义**：`admin_users.status` 的取值未在文档中给出。
 * 按 `merchants.status` 的同构风格补充。
 */
export const ADMIN_USER_STATUS = {
  ACTIVE: "active",
  DISABLED: "disabled",
  LOCKED: "locked",
} as const;
export type AdminUserStatus = (typeof ADMIN_USER_STATUS)[keyof typeof ADMIN_USER_STATUS];
export const AdminUserStatusSchema = z.enum(ADMIN_USER_STATUS);

/** ⚠️ **文档未定义**：`users.status` 的取值未在文档中给出。 */
export const USER_STATUS = {
  ACTIVE: "active",
  DISABLED: "disabled",
} as const;
export type UserStatus = (typeof USER_STATUS)[keyof typeof USER_STATUS];
export const UserStatusSchema = z.enum(USER_STATUS);

/** 币种。07 §7.2 fixture 固定为 `CNY`。 */
export const CURRENCY = "CNY" as const;
export const CurrencySchema = z.literal(CURRENCY);
