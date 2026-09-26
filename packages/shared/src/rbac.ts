/**
 * RBAC 权限点与内置角色（契约中心，零业务逻辑）。
 *
 * 权威来源：`docs/09-认证权限与部署.md` §9.2「RBAC 权限矩阵（8 角色）」。
 *
 * 命名规则：**`域:动作`**。Agent scope 采用 `agent:<域>:read|write` 三段式。
 * 前端同源渲染与后端 `requirePerm()` 中间件共用本文件的定义。
 */

import { AGENT_SCOPE } from "./enums.js";

/* -------------------------------------------------------------------------- */
/* 权限点（09 §9.2 逐字照录）                                                   */
/* -------------------------------------------------------------------------- */

export const PERMISSIONS = {
  /** 商户审核。 */
  MERCHANT_APPROVE: "merchant:approve",
  /** 商品审核。 */
  PRODUCT_REVIEW: "product:review",
  /** 订单发货。 */
  ORDER_SHIP: "order:ship",
  /** 售后审批。 */
  AFTERSALE_APPROVE: "aftersale:approve",
  /** 结算确认。 */
  SETTLEMENT_CONFIRM: "settlement:confirm",
  /** Agent 服务令牌管理（签发/吊销）。 */
  AGENT_TOKEN_MANAGE: "agent:token:manage",
  /** 售后政策发布。 */
  AFTERSALE_POLICY_MANAGE: "aftersale:policy:manage",
  /** 任务队列死信运维（查看 / 重放失败任务）。 */
  TASK_DEAD_LETTER_MANAGE: "task:dead_letter:manage",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** 权限点全集（用于「是否合法权限点」的校验）。 */
export const ALL_PERMISSIONS: readonly Permission[] = Object.values(PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return (ALL_PERMISSIONS as readonly string[]).includes(value);
}

/* -------------------------------------------------------------------------- */
/* 内置角色（09 §9.2 的 8 个角色）                                              */
/* -------------------------------------------------------------------------- */

/** 平台侧角色 code（`roles.scope = 'platform'`）。 */
export const PLATFORM_ROLE = {
  /** 平台超管：全部权限，含 `agent:token:manage`。 */
  SUPER_ADMIN: "platform_super_admin",
  /** 平台运营：类目/商品审核、营销、内容位、**政策发布**。 */
  OPERATOR: "platform_operator",
  /** 平台财务：结算确认、对账、退款复核。 */
  FINANCE: "platform_finance",
  /** 平台客服：订单查询、售后介入；**不可**改商品与资金配置。 */
  SUPPORT: "platform_support",
} as const;

export type PlatformRole = (typeof PLATFORM_ROLE)[keyof typeof PLATFORM_ROLE];

/** 商户侧角色 code（`roles.scope = 'merchant'`）。 */
export const MERCHANT_ROLE = {
  /** 商户管理员：本商户全部权限。 */
  ADMIN: "merchant_admin",
  /** 商户店员：发货、售后处理；**无**改价与店员管理。 */
  STAFF: "merchant_staff",
} as const;

export type MerchantRole = (typeof MERCHANT_ROLE)[keyof typeof MERCHANT_ROLE];

/** 角色 code → 权限点集合。 */
export const ROLE_PERMISSIONS: Record<string, readonly Permission[]> = {
  [PLATFORM_ROLE.SUPER_ADMIN]: ALL_PERMISSIONS,
  [PLATFORM_ROLE.OPERATOR]: [
    PERMISSIONS.PRODUCT_REVIEW,
    PERMISSIONS.MERCHANT_APPROVE,
    PERMISSIONS.AFTERSALE_POLICY_MANAGE,
  ],
  [PLATFORM_ROLE.FINANCE]: [PERMISSIONS.SETTLEMENT_CONFIRM],
  [PLATFORM_ROLE.SUPPORT]: [PERMISSIONS.AFTERSALE_APPROVE],
  [MERCHANT_ROLE.ADMIN]: [PERMISSIONS.ORDER_SHIP, PERMISSIONS.AFTERSALE_APPROVE],
  [MERCHANT_ROLE.STAFF]: [PERMISSIONS.ORDER_SHIP, PERMISSIONS.AFTERSALE_APPROVE],
};

/**
 * 第 8 个角色：**PiEcho Agent 服务身份**。
 *
 * 它不落在 `roles` 表（那是后台账号用的），而是由 `service_tokens.scopes` 承载：
 * `/agent/*` 只读，**无任何写权限**。此处显式声明以对齐 09 §9.2 的 8 角色表述。
 */
export const AGENT_SERVICE_IDENTITY = {
  code: "agent_service",
  scopes: Object.values(AGENT_SCOPE),
} as const;

/**
 * 角色是否拥有某权限。
 *
 * 商户侧权限受 `merchantScope` 行级隔离约束（见 `apps/api` 中间件），
 * 本函数只做「权限点是否命中」的判断。
 */
export function roleHasPermission(roleCode: string, permission: Permission): boolean {
  return ROLE_PERMISSIONS[roleCode]?.includes(permission) ?? false;
}

/** 汇总多个角色的权限点（去重）。 */
export function permissionsForRoles(roleCodes: readonly string[]): Permission[] {
  const set = new Set<Permission>();
  for (const code of roleCodes) {
    for (const p of ROLE_PERMISSIONS[code] ?? []) set.add(p);
  }
  return [...set];
}
