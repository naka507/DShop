/**
 * Agent API 统一错误码（契约中心，零业务逻辑）。
 *
 * 权威来源：`docs/07-Agent-API契约.md` §7.1「统一错误码表（Agent 组）」。
 * 14 项含成功码 `0`，**逐字照录**，不做增删。
 *
 * ⚠️ 这些码与 PiEcho 侧 `ESHOP_ERROR_CODES` 是**同一套**（PiEcho 照抄 DShop 契约）。
 * 任何改动必须两侧同步——本文件是权威定义方。
 *
 * 本文件**同时**承载两组互斥的错误码（`docs/README.md:34`）：
 * - `AGENT_ERROR_CODES`（**整数**）—— 仅 `/api/v1/agent/*`（07 §7.1，PiEcho 照抄）
 * - 后台组字符串码 `ERR_<域>_<原因>`（**字符串**）—— `shop` / `admin` / `merchant` /
 *   `callbacks` 四域（`docs/06-API路由命名空间.md:11-14`）。两组**严禁混用**，
 *   见文末分流函数。
 */

import { z } from "zod";

/** 错误码元信息。 */
export interface ErrorCodeMeta {
  /** HTTP 状态码。 */
  readonly http: number;
  /** 语义（中文，取自 07 §7.1 表格）。 */
  readonly message: string;
}

export const AGENT_ERROR_CODES = {
  /** 200 成功。 */
  OK: 0,
  /** 400 参数校验失败（缺参 / 类型错 / 越界）。 */
  INVALID_PARAM: 40001,
  /** 400 显式提供了不受支持的 `X-Contract-Version`（**缺失不报此错**）。 */
  UNSUPPORTED_CONTRACT_VERSION: 40010,
  /** 401 服务令牌缺失或无效。 */
  TOKEN_MISSING_OR_INVALID: 40101,
  /** 401 服务令牌已吊销或已过期。 */
  TOKEN_REVOKED: 40102,
  /** 403 令牌 scope 不含该资源。 */
  SCOPE_INSUFFICIENT: 40301,
  /** 404 订单不存在。 */
  ORDER_NOT_FOUND: 40401,
  /** 404 商品不存在或已删除。 */
  PRODUCT_NOT_FOUND: 40402,
  /** 404 售后单不存在。 */
  AFTERSALE_NOT_FOUND: 40403,
  /** 404 政策分类无生效条款。 */
  POLICY_NOT_EFFECTIVE: 40404,
  /** 405 对 Agent 组使用了非 GET 方法。 */
  METHOD_NOT_ALLOWED: 40501,
  /** 409 受控写幂等冲突或状态不允许。 */
  IDEMPOTENCY_CONFLICT: 40901,
  /** 429 触发限流。 */
  RATE_LIMITED: 42901,
  /** 500 服务内部错误。 */
  INTERNAL_ERROR: 50001,
} as const;

export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[keyof typeof AGENT_ERROR_CODES];

/** 错误码元信息表（HTTP 状态与语义）。 */
export const AGENT_ERROR_META: Record<AgentErrorCode, ErrorCodeMeta> = {
  [AGENT_ERROR_CODES.OK]: { http: 200, message: "成功" },
  [AGENT_ERROR_CODES.INVALID_PARAM]: { http: 400, message: "参数校验失败" },
  [AGENT_ERROR_CODES.UNSUPPORTED_CONTRACT_VERSION]: {
    http: 400,
    message: "不支持的契约版本",
  },
  [AGENT_ERROR_CODES.TOKEN_MISSING_OR_INVALID]: {
    http: 401,
    message: "服务令牌缺失或无效",
  },
  [AGENT_ERROR_CODES.TOKEN_REVOKED]: {
    http: 401,
    message: "服务令牌已吊销或已过期",
  },
  [AGENT_ERROR_CODES.SCOPE_INSUFFICIENT]: {
    http: 403,
    message: "令牌 scope 不含该资源",
  },
  [AGENT_ERROR_CODES.ORDER_NOT_FOUND]: { http: 404, message: "订单不存在" },
  [AGENT_ERROR_CODES.PRODUCT_NOT_FOUND]: {
    http: 404,
    message: "商品不存在或已删除",
  },
  [AGENT_ERROR_CODES.AFTERSALE_NOT_FOUND]: {
    http: 404,
    message: "售后单不存在",
  },
  [AGENT_ERROR_CODES.POLICY_NOT_EFFECTIVE]: {
    http: 404,
    message: "政策分类无生效条款",
  },
  [AGENT_ERROR_CODES.METHOD_NOT_ALLOWED]: {
    http: 405,
    message: "对 Agent 组使用了非 GET 方法",
  },
  [AGENT_ERROR_CODES.IDEMPOTENCY_CONFLICT]: {
    http: 409,
    message: "受控写幂等冲突或状态不允许",
  },
  [AGENT_ERROR_CODES.RATE_LIMITED]: { http: 429, message: "触发限流" },
  [AGENT_ERROR_CODES.INTERNAL_ERROR]: {
    http: 500,
    message: "服务内部错误",
  },
};

/** 错误码 Zod enum（用于响应体校验）。 */
export const AgentErrorCodeSchema = z.enum(AGENT_ERROR_CODES);

/** 取错误码对应的 HTTP 状态；未知码返回 `500`。 */
export function httpStatusFor(code: number): number {
  return AGENT_ERROR_META[code as AgentErrorCode]?.http ?? 500;
}

/** 取错误码的语义文本；未知码返回「未知错误」。 */
export function messageFor(code: number): string {
  return AGENT_ERROR_META[code as AgentErrorCode]?.message ?? "未知错误";
}

/**
 * 统一响应体 `{ code, message, data }`。
 *
 * `code` 为整数，`0` 表示成功（07 §7.1）。成功时 `message` 为 `"ok"`（07 fixture 口径），
 * 失败时为 `AGENT_ERROR_META[code].message`。
 */
export const AgentEnvelopeSchema = z.object({
  code: AgentErrorCodeSchema,
  message: z.string(),
  data: z.unknown(),
});
export type AgentEnvelope = z.infer<typeof AgentEnvelopeSchema>;

/** 成功响应 `message` 常量（07 fixture 全部为 `"ok"`）。 */
export const OK_MESSAGE = "ok" as const;

/* -------------------------------------------------------------------------- */
/* 后台三组（shop / admin / merchant）字符串错误码                              */
/* -------------------------------------------------------------------------- */

/**
 * 后台组字符串错误码（`docs/README.md:34`）。
 *
 * 权威依据：
 * - `docs/README.md:34`：「错误码：Agent 组用**整数**码；shop/admin/merchant 用字符串码。」
 * - `docs/06-API路由命名空间.md:20`：「`code === 0` 为成功；非 0 为业务错误码……
 *   `ORDER_STOCK_NOT_ENOUGH` 一类**字符串错误码仅用于 shop / admin / merchant 三组**，两组不混用。」
 *
 * 命名格式：`ERR_<域>_<原因>`，**全大写 + 下划线**。
 *
 * ⚠️ **严禁与 `AGENT_ERROR_CODES` 混用**：
 * - `/api/v1/agent/*` 只允许返回整数码（07 §7.1，PiEcho 侧契约，破坏性变更需 ≥90 天双版本）；
 * - shop / admin / merchant 只允许返回本表字符串码。
 * 两组的值域**完全不重叠**（整数 vs `ERR_` 前缀字符串），故可用 `typeof code` 判定归属。
 * 分流规则见文末 `isAgentPath()` / `backofficeDomainForPath()`。
/**
 * 后台组域名（路径前缀 → 域，`docs/06` §6 的四个非 Agent 命名空间）。
 *
 * ⚠️ `AGENT` **不在此枚举内**：Agent 组用整数码，归属判定走 `isAgentPath()`
 * （两组的值域完全不重叠，故必须分开判）。
 */
export const BACKOFFICE_DOMAIN = {
  SHOP: "shop",
  ADMIN: "admin",
  MERCHANT: "merchant",
  CALLBACK: "callbacks",
} as const;
export type BackofficeDomain = (typeof BACKOFFICE_DOMAIN)[keyof typeof BACKOFFICE_DOMAIN];

/** 后台组每个域共有的错误码键（保证三个表结构一致，便于按路径取表）。 */
export interface BackofficeErrorTable {
  /** 400 参数校验失败。 */
  readonly INVALID_PARAM: string;
  /** 401 未携带凭据。 */
  readonly TOKEN_MISSING: string;
  /** 401 凭据无效（不区分「不存在」与「密码错」，防枚举）。 */
  readonly TOKEN_INVALID: string;
  /** 401 凭据已吊销或已过期。 */
  readonly TOKEN_REVOKED: string;
  /** 403 缺少权限点 / 行级越权。 */
  readonly PERMISSION_DENIED: string;
  /** 404 资源不存在。 */
  readonly NOT_FOUND: string;
  /** 500 服务内部错误。 */
  readonly INTERNAL_ERROR: string;
}

/** 平台后台（`/api/v1/admin/*`）错误码。 */
export const ADMIN_ERROR_CODES = {
  INVALID_PARAM: "ERR_ADMIN_INVALID_PARAM",
  TOKEN_MISSING: "ERR_ADMIN_TOKEN_MISSING",
  TOKEN_INVALID: "ERR_ADMIN_TOKEN_INVALID",
  TOKEN_REVOKED: "ERR_ADMIN_TOKEN_REVOKED",
  PERMISSION_DENIED: "ERR_ADMIN_PERMISSION_DENIED",
  NOT_FOUND: "ERR_ADMIN_NOT_FOUND",
  INTERNAL_ERROR: "ERR_ADMIN_INTERNAL_ERROR",
  /** 401 高风险操作（签发 Agent 令牌）缺少动态验证码。 */
  TOTP_REQUIRED: "ERR_ADMIN_TOTP_REQUIRED",
  /** 401 动态验证码错误。 */
  TOTP_INVALID: "ERR_ADMIN_TOTP_INVALID",
  /** 401 账号因连续登录失败被锁定（`docs/09` §9.1）。 */
  ACCOUNT_LOCKED: "ERR_ADMIN_ACCOUNT_LOCKED",
  /** 403 账号状态不可用。 */
  ACCOUNT_DISABLED: "ERR_ADMIN_ACCOUNT_DISABLED",
  /** 404 目标 Agent 服务令牌不存在。 */
  AGENT_TOKEN_NOT_FOUND: "ERR_ADMIN_AGENT_TOKEN_NOT_FOUND",
  /** 409 Agent 服务令牌已吊销（不可重复吊销）。 */
  AGENT_TOKEN_ALREADY_REVOKED: "ERR_ADMIN_AGENT_TOKEN_ALREADY_REVOKED",
  /** 409 售后政策版本冲突（同分类同版本号已存在）。 */
  POLICY_VERSION_CONFLICT: "ERR_ADMIN_POLICY_VERSION_CONFLICT",
} as const satisfies BackofficeErrorTable & Record<string, string>;

/**
 * C 端商城（`/api/v1/shop/*`）错误码。
 *
 * 前 7 个键为 `BackofficeErrorTable` 的公共键（表结构一致，便于按路径取表）；
 * 其余为本域特有码，语义依据：`docs/06` §6、`docs/08` §8.2–§8.4。
 */
export const SHOP_ERROR_CODES = {
  INVALID_PARAM: "ERR_SHOP_INVALID_PARAM",
  TOKEN_MISSING: "ERR_SHOP_TOKEN_MISSING",
  TOKEN_INVALID: "ERR_SHOP_TOKEN_INVALID",
  TOKEN_REVOKED: "ERR_SHOP_TOKEN_REVOKED",
  PERMISSION_DENIED: "ERR_SHOP_PERMISSION_DENIED",
  NOT_FOUND: "ERR_SHOP_NOT_FOUND",
  INTERNAL_ERROR: "ERR_SHOP_INTERNAL_ERROR",
  /** 401 未登录（`/shop/auth/me` 等需登录端点的统一码，语义与 `TOKEN_MISSING` 同）。 */
  UNAUTHORIZED: "ERR_SHOP_UNAUTHORIZED",
  /** 429 触发限流（下单 / 发码等写操作按 IP 与用户双维度限流）。 */
  RATE_LIMITED: "ERR_SHOP_RATE_LIMITED",
  /** 404 订单不存在或不属于当前用户（不区分，防枚举）。 */
  ORDER_NOT_FOUND: "ERR_SHOP_ORDER_NOT_FOUND",
  /** 404 商品不存在或已下架。 */
  PRODUCT_NOT_FOUND: "ERR_SHOP_PRODUCT_NOT_FOUND",
  /** 404 售后单不存在或不属于当前用户。 */
  AFTERSALE_NOT_FOUND: "ERR_SHOP_AFTERSALE_NOT_FOUND",
  /** 404 收货地址不存在。 */
  ADDRESS_NOT_FOUND: "ERR_SHOP_ADDRESS_NOT_FOUND",
  /** 409 可售库存不足（`stock - locked_stock < 需求`，`docs/08` §8.2）。 */
  STOCK_INSUFFICIENT: "ERR_SHOP_STOCK_INSUFFICIENT",
  /** 409 商品已下架 / 售罄，不可下单（购物车行的 `available = false`）。 */
  PRODUCT_NOT_AVAILABLE: "ERR_SHOP_PRODUCT_NOT_AVAILABLE",
  /** 409 幂等键冲突：同 `Idempotency-Key` 但请求体不同（`docs/06` §6）。 */
  IDEMPOTENCY_CONFLICT: "ERR_SHOP_IDEMPOTENCY_CONFLICT",
  /** 409 订单状态不允许当前操作（`docs/08` §8.3 状态机）。 */
  ORDER_STATE_CONFLICT: "ERR_SHOP_ORDER_STATE_CONFLICT",
  /** 409 售后单状态不允许当前操作（`docs/08` §8.4 状态机）。 */
  AFTERSALE_STATE_CONFLICT: "ERR_SHOP_AFTERSALE_STATE_CONFLICT",
  /** 400 支付渠道不受支持或与订单不匹配。 */
  PAYMENT_CHANNEL_UNSUPPORTED: "ERR_SHOP_PAYMENT_CHANNEL_UNSUPPORTED",
  /** 400 金额不一致（结算试算与提交订单时的价格漂移）。 */
  AMOUNT_MISMATCH: "ERR_SHOP_AMOUNT_MISMATCH",
  /** 401 短信验证码错误或已过期。 */
  SMS_CODE_INVALID: "ERR_SHOP_SMS_CODE_INVALID",
  /** 429 短信验证码发送过频（`docs/08` §8.1：60s 冷却）。 */
  SMS_CODE_RATE_LIMITED: "ERR_SHOP_SMS_CODE_RATE_LIMITED",
  /** 403 账号状态不可用（`users.status != 'active'`）。 */
  ACCOUNT_DISABLED: "ERR_SHOP_ACCOUNT_DISABLED",
} as const satisfies BackofficeErrorTable & Record<string, string>;

/**
 * 商户后台（`/api/v1/merchant/*`）错误码。
 *
 * 语义依据：`docs/06` §6、`docs/08` §8.4、`docs/09` §9.1–§9.2（`merchantScope` 行级隔离）。
 */
export const MERCHANT_ERROR_CODES = {
  INVALID_PARAM: "ERR_MERCHANT_INVALID_PARAM",
  TOKEN_MISSING: "ERR_MERCHANT_TOKEN_MISSING",
  TOKEN_INVALID: "ERR_MERCHANT_TOKEN_INVALID",
  TOKEN_REVOKED: "ERR_MERCHANT_TOKEN_REVOKED",
  PERMISSION_DENIED: "ERR_MERCHANT_PERMISSION_DENIED",
  NOT_FOUND: "ERR_MERCHANT_NOT_FOUND",
  INTERNAL_ERROR: "ERR_MERCHANT_INTERNAL_ERROR",
  /** 401 未登录（与 `TOKEN_MISSING` 同语义的别名，便于前端统一判定）。 */
  UNAUTHORIZED: "ERR_MERCHANT_UNAUTHORIZED",
  /** 403 已登录但权限点不足（`requirePerm()` 拦截，`docs/09` §9.2）。 */
  FORBIDDEN: "ERR_MERCHANT_FORBIDDEN",
  /** 403 跨商户越权（`merchantScope` 行级隔离拒绝，`docs/09` §9.2）。 */
  SCOPE_VIOLATION: "ERR_MERCHANT_SCOPE_VIOLATION",
  /** 401 账号因连续登录失败被锁定（`docs/08` §8.1：5 次锁 15 分钟）。 */
  ACCOUNT_LOCKED: "ERR_MERCHANT_ACCOUNT_LOCKED",
  /** 403 账号状态不可用。 */
  ACCOUNT_DISABLED: "ERR_MERCHANT_ACCOUNT_DISABLED",
  /** 401 高风险操作缺少动态验证码。 */
  TOTP_REQUIRED: "ERR_MERCHANT_TOTP_REQUIRED",
  /** 401 动态验证码错误。 */
  TOTP_INVALID: "ERR_MERCHANT_TOTP_INVALID",
  /** 429 触发限流。 */
  RATE_LIMITED: "ERR_MERCHANT_RATE_LIMITED",
  /** 404 订单不存在或不属于当前商户（不区分，防枚举）。 */
  ORDER_NOT_FOUND: "ERR_MERCHANT_ORDER_NOT_FOUND",
  /** 404 售后单不存在或不属于当前商户。 */
  AFTERSALE_NOT_FOUND: "ERR_MERCHANT_AFTERSALE_NOT_FOUND",
  /** 409 订单 / 子单状态不允许当前操作（`docs/08` §8.3 状态机）。 */
  ORDER_STATE_CONFLICT: "ERR_MERCHANT_ORDER_STATE_CONFLICT",
  /** 409 售后单状态不允许当前操作（`docs/08` §8.4 状态机）。 */
  AFTERSALE_STATE_CONFLICT: "ERR_MERCHANT_AFTERSALE_STATE_CONFLICT",
} as const satisfies BackofficeErrorTable & Record<string, string>;

/**
 * 支付回调（`/api/v1/callbacks/*`）错误码。
 *
 * ⚠️ **回调无鉴权**（`docs/06` §6：验签，无鉴权），故 `TOKEN_*` / `PERMISSION_DENIED`
 * 三个公共键在本域**仅为表结构一致而保留**（`backofficeErrorCodesFor()` 按域取表时
 * 需要同构），实际不会返回。真正的安全判据是**验签**。
 *
 * 语义依据：`docs/08` §8.2（验签 + `channel_trade_no` 唯一约束幂等校验）。
 */
export const CALLBACK_ERROR_CODES = {
  /** 400 回调报文不合法（JSON 解析失败 / 字段缺失）。 */
  INVALID_PARAM: "ERR_CALLBACK_INVALID_PARAM",
  /** ⚠️ 保留键：回调无鉴权，实际不会返回。 */
  TOKEN_MISSING: "ERR_CALLBACK_TOKEN_MISSING",
  /** ⚠️ 保留键：回调无鉴权，实际不会返回。 */
  TOKEN_INVALID: "ERR_CALLBACK_TOKEN_INVALID",
  /** ⚠️ 保留键：回调无鉴权，实际不会返回。 */
  TOKEN_REVOKED: "ERR_CALLBACK_TOKEN_REVOKED",
  /** ⚠️ 保留键：回调无鉴权，实际不会返回。 */
  PERMISSION_DENIED: "ERR_CALLBACK_PERMISSION_DENIED",
  /** 404 回调指向的订单 / 支付单不存在。 */
  NOT_FOUND: "ERR_CALLBACK_NOT_FOUND",
  /** 500 回调处理失败（渠道会按策略重试）。 */
  INTERNAL_ERROR: "ERR_CALLBACK_INTERNAL_ERROR",
  /** 401 验签相关请求头缺失（微信 v3 的四个 `Wechatpay-*` 头 / 支付宝的 `sign`）。 */
  SIGNATURE_MISSING: "ERR_CALLBACK_SIGNATURE_MISSING",
  /** 401 验签失败（签名不匹配）。 */
  SIGNATURE_INVALID: "ERR_CALLBACK_SIGNATURE_INVALID",
  /** 401 回调时间戳超出容忍窗口（默认 5 分钟），视为重放。 */
  TIMESTAMP_EXPIRED: "ERR_CALLBACK_TIMESTAMP_EXPIRED",
  /** 400 微信 `resource` 解密失败（`AEAD_AES_256_GCM`）。 */
  DECRYPT_FAILED: "ERR_CALLBACK_DECRYPT_FAILED",
  /** 400 回调金额与 `orders.pay_amount` 不一致。 */
  AMOUNT_MISMATCH: "ERR_CALLBACK_AMOUNT_MISMATCH",
  /** 409 `channel_trade_no` 已绑定到另一订单（唯一约束冲突）。 */
  TRADE_NO_CONFLICT: "ERR_CALLBACK_TRADE_NO_CONFLICT",
  /** 400 渠道标识不受支持（非微信 / 支付宝）。 */
  CHANNEL_UNSUPPORTED: "ERR_CALLBACK_CHANNEL_UNSUPPORTED",
} as const satisfies BackofficeErrorTable & Record<string, string>;

/** 后台组字符串错误码全集（去重后的字面量联合类型）。 */
export type BackofficeErrorCode =
  | (typeof ADMIN_ERROR_CODES)[keyof typeof ADMIN_ERROR_CODES]
  | (typeof SHOP_ERROR_CODES)[keyof typeof SHOP_ERROR_CODES]
  | (typeof MERCHANT_ERROR_CODES)[keyof typeof MERCHANT_ERROR_CODES]
  | (typeof CALLBACK_ERROR_CODES)[keyof typeof CALLBACK_ERROR_CODES];

/**
 * 字符串错误码元信息（HTTP 状态与中文语义）。
 *
 * ⚠️ 与 `AGENT_ERROR_META` **分表**：整数码与字符串码的映射绝不交叉。
 */
export const BACKOFFICE_ERROR_META: Record<BackofficeErrorCode, ErrorCodeMeta> = {
  [ADMIN_ERROR_CODES.INVALID_PARAM]: { http: 400, message: "参数校验失败" },
  [ADMIN_ERROR_CODES.TOKEN_MISSING]: { http: 401, message: "未登录" },
  [ADMIN_ERROR_CODES.TOKEN_INVALID]: { http: 401, message: "账号或密码错误" },
  [ADMIN_ERROR_CODES.TOKEN_REVOKED]: { http: 401, message: "凭据已吊销或已过期" },
  [ADMIN_ERROR_CODES.PERMISSION_DENIED]: { http: 403, message: "缺少所需权限" },
  [ADMIN_ERROR_CODES.NOT_FOUND]: { http: 404, message: "资源不存在" },
  [ADMIN_ERROR_CODES.INTERNAL_ERROR]: { http: 500, message: "服务内部错误" },
  [ADMIN_ERROR_CODES.TOTP_REQUIRED]: { http: 401, message: "该操作需要动态验证码" },
  [ADMIN_ERROR_CODES.TOTP_INVALID]: { http: 401, message: "动态验证码错误" },
  [ADMIN_ERROR_CODES.ACCOUNT_LOCKED]: { http: 401, message: "账号已锁定，请稍后重试" },
  [ADMIN_ERROR_CODES.ACCOUNT_DISABLED]: { http: 403, message: "账号不可用" },
  [ADMIN_ERROR_CODES.AGENT_TOKEN_NOT_FOUND]: {
    http: 404,
    message: "Agent 服务令牌不存在",
  },
  [ADMIN_ERROR_CODES.AGENT_TOKEN_ALREADY_REVOKED]: {
    http: 409,
    message: "Agent 服务令牌已吊销",
  },
  [ADMIN_ERROR_CODES.POLICY_VERSION_CONFLICT]: {
    http: 409,
    message: "同分类同版本号的售后政策已存在",
  },
  [SHOP_ERROR_CODES.INVALID_PARAM]: { http: 400, message: "参数校验失败" },
  [SHOP_ERROR_CODES.TOKEN_MISSING]: { http: 401, message: "未登录" },
  [SHOP_ERROR_CODES.TOKEN_INVALID]: { http: 401, message: "登录状态无效" },
  [SHOP_ERROR_CODES.TOKEN_REVOKED]: { http: 401, message: "凭据已吊销或已过期" },
  [SHOP_ERROR_CODES.PERMISSION_DENIED]: { http: 403, message: "缺少所需权限" },
  [SHOP_ERROR_CODES.NOT_FOUND]: { http: 404, message: "资源不存在" },
  [SHOP_ERROR_CODES.INTERNAL_ERROR]: { http: 500, message: "服务内部错误" },
  [SHOP_ERROR_CODES.UNAUTHORIZED]: { http: 401, message: "未登录" },
  [SHOP_ERROR_CODES.RATE_LIMITED]: { http: 429, message: "操作过于频繁，请稍后重试" },
  [SHOP_ERROR_CODES.ORDER_NOT_FOUND]: { http: 404, message: "订单不存在" },
  [SHOP_ERROR_CODES.PRODUCT_NOT_FOUND]: { http: 404, message: "商品不存在或已下架" },
  [SHOP_ERROR_CODES.AFTERSALE_NOT_FOUND]: { http: 404, message: "售后单不存在" },
  [SHOP_ERROR_CODES.ADDRESS_NOT_FOUND]: { http: 404, message: "收货地址不存在" },
  [SHOP_ERROR_CODES.STOCK_INSUFFICIENT]: { http: 409, message: "库存不足" },
  [SHOP_ERROR_CODES.PRODUCT_NOT_AVAILABLE]: { http: 409, message: "商品不可购买" },
  [SHOP_ERROR_CODES.IDEMPOTENCY_CONFLICT]: { http: 409, message: "重复提交（幂等键冲突）" },
  [SHOP_ERROR_CODES.ORDER_STATE_CONFLICT]: { http: 409, message: "订单当前状态不允许该操作" },
  [SHOP_ERROR_CODES.AFTERSALE_STATE_CONFLICT]: {
    http: 409,
    message: "售后单当前状态不允许该操作",
  },
  [SHOP_ERROR_CODES.PAYMENT_CHANNEL_UNSUPPORTED]: {
    http: 400,
    message: "不支持的支付渠道",
  },
  [SHOP_ERROR_CODES.AMOUNT_MISMATCH]: { http: 400, message: "金额与订单不一致，请刷新后重试" },
  [SHOP_ERROR_CODES.SMS_CODE_INVALID]: { http: 401, message: "验证码错误或已过期" },
  [SHOP_ERROR_CODES.SMS_CODE_RATE_LIMITED]: { http: 429, message: "验证码发送过于频繁" },
  [SHOP_ERROR_CODES.ACCOUNT_DISABLED]: { http: 403, message: "账号不可用" },
  [MERCHANT_ERROR_CODES.INVALID_PARAM]: { http: 400, message: "参数校验失败" },
  [MERCHANT_ERROR_CODES.TOKEN_MISSING]: { http: 401, message: "未登录" },
  [MERCHANT_ERROR_CODES.TOKEN_INVALID]: { http: 401, message: "登录状态无效" },
  [MERCHANT_ERROR_CODES.TOKEN_REVOKED]: { http: 401, message: "凭据已吊销或已过期" },
  [MERCHANT_ERROR_CODES.PERMISSION_DENIED]: { http: 403, message: "缺少所需权限" },
  [MERCHANT_ERROR_CODES.NOT_FOUND]: { http: 404, message: "资源不存在" },
  [MERCHANT_ERROR_CODES.INTERNAL_ERROR]: { http: 500, message: "服务内部错误" },
  [MERCHANT_ERROR_CODES.UNAUTHORIZED]: { http: 401, message: "未登录" },
  [MERCHANT_ERROR_CODES.FORBIDDEN]: { http: 403, message: "没有该操作的权限" },
  [MERCHANT_ERROR_CODES.SCOPE_VIOLATION]: { http: 403, message: "无权访问该商户数据" },
  [MERCHANT_ERROR_CODES.ACCOUNT_LOCKED]: { http: 401, message: "账号已锁定，请稍后重试" },
  [MERCHANT_ERROR_CODES.ACCOUNT_DISABLED]: { http: 403, message: "账号不可用" },
  [MERCHANT_ERROR_CODES.TOTP_REQUIRED]: { http: 401, message: "该操作需要动态验证码" },
  [MERCHANT_ERROR_CODES.TOTP_INVALID]: { http: 401, message: "动态验证码错误" },
  [MERCHANT_ERROR_CODES.RATE_LIMITED]: { http: 429, message: "操作过于频繁，请稍后重试" },
  [MERCHANT_ERROR_CODES.ORDER_NOT_FOUND]: { http: 404, message: "订单不存在" },
  [MERCHANT_ERROR_CODES.AFTERSALE_NOT_FOUND]: { http: 404, message: "售后单不存在" },
  [MERCHANT_ERROR_CODES.ORDER_STATE_CONFLICT]: { http: 409, message: "订单当前状态不允许该操作" },
  [MERCHANT_ERROR_CODES.AFTERSALE_STATE_CONFLICT]: {
    http: 409,
    message: "售后单当前状态不允许该操作",
  },
  [CALLBACK_ERROR_CODES.INVALID_PARAM]: { http: 400, message: "回调报文不合法" },
  [CALLBACK_ERROR_CODES.TOKEN_MISSING]: { http: 401, message: "回调无鉴权（保留码）" },
  [CALLBACK_ERROR_CODES.TOKEN_INVALID]: { http: 401, message: "回调无鉴权（保留码）" },
  [CALLBACK_ERROR_CODES.TOKEN_REVOKED]: { http: 401, message: "回调无鉴权（保留码）" },
  [CALLBACK_ERROR_CODES.PERMISSION_DENIED]: { http: 403, message: "回调无鉴权（保留码）" },
  [CALLBACK_ERROR_CODES.NOT_FOUND]: { http: 404, message: "回调指向的订单或支付单不存在" },
  [CALLBACK_ERROR_CODES.INTERNAL_ERROR]: { http: 500, message: "回调处理失败" },
  [CALLBACK_ERROR_CODES.SIGNATURE_MISSING]: { http: 401, message: "缺少验签信息" },
  [CALLBACK_ERROR_CODES.SIGNATURE_INVALID]: { http: 401, message: "验签失败" },
  [CALLBACK_ERROR_CODES.TIMESTAMP_EXPIRED]: { http: 401, message: "回调时间戳超出容忍窗口" },
  [CALLBACK_ERROR_CODES.DECRYPT_FAILED]: { http: 400, message: "回调资源解密失败" },
  [CALLBACK_ERROR_CODES.AMOUNT_MISMATCH]: { http: 400, message: "回调金额与订单金额不一致" },
  [CALLBACK_ERROR_CODES.TRADE_NO_CONFLICT]: { http: 409, message: "渠道交易号已被占用" },
  [CALLBACK_ERROR_CODES.CHANNEL_UNSUPPORTED]: { http: 400, message: "不支持的支付渠道" },
};

/** 取字符串错误码对应的 HTTP 状态；未知码返回 `500`。 */
export function backofficeHttpStatusFor(code: string): number {
  return BACKOFFICE_ERROR_META[code as BackofficeErrorCode]?.http ?? 500;
}

/** 取字符串错误码的语义文本；未知码返回「未知错误」。 */
export function backofficeMessageFor(code: string): string {
  return BACKOFFICE_ERROR_META[code as BackofficeErrorCode]?.message ?? "未知错误";
}

/* -------------------------------------------------------------------------- */
/* 路径分流（决定用整数码还是字符串码，`docs/06:11-15`）                        */
/* -------------------------------------------------------------------------- */

/** Agent 路由组前缀（`docs/06:15`）。**不 import 其他模块**，保持本文件零依赖。 */
export const AGENT_PATH_PREFIX = "/api/v1/agent";

/** C 端商城路由前缀（`docs/06:11`）。 */
export const SHOP_PATH_PREFIX = "/api/v1/shop";

/** 商户后台路由前缀（`docs/06:12`）。 */
export const MERCHANT_PATH_PREFIX = "/api/v1/merchant";

/** 平台后台路由前缀（`docs/06:13`）。 */
export const ADMIN_PATH_PREFIX = "/api/v1/admin";

/** 支付回调路由前缀（`docs/06:14`）。 */
export const CALLBACK_PATH_PREFIX = "/api/v1/callbacks";

/**
 * 路径是否落在某前缀**之下**（按路径段判定）。
 *
 * ⚠️ 不用裸 `startsWith(prefix)`：那会把 `/api/v1/shopx` 误判为 shop 域。
 * 判定条件为「等于前缀」或「前缀 + `/`」开头。
 */
export function isUnderPathPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * 该路径是否属于 Agent 组（决定用整数码还是字符串码）。
 *
 * ⚠️ 这是**分层边界**：`/api/v1/agent/*` 的未知路径必须返回整数 `40401`
 * （`apps/api/src/index.ts` 的 `notFound`），其余四域返回字符串码。
 */
export function isAgentPath(path: string): boolean {
  return isUnderPathPrefix(path, AGENT_PATH_PREFIX);
}

/**
 * 路径 → 后台组域名（`docs/06:11-14` 的四个非 Agent 命名空间）。
 *
 * ⚠️ **兜底为 `admin`**：调用方在取域前应先过 `isAgentPath()`；对 Agent 路径调用本函数
 * 会得到 `admin`（Agent 组不属任何后台域，其错误码表在 `AGENT_ERROR_CODES`）。
 */
export function backofficeDomainForPath(path: string): BackofficeDomain {
  if (isUnderPathPrefix(path, SHOP_PATH_PREFIX)) return BACKOFFICE_DOMAIN.SHOP;
  if (isUnderPathPrefix(path, MERCHANT_PATH_PREFIX)) return BACKOFFICE_DOMAIN.MERCHANT;
  if (isUnderPathPrefix(path, CALLBACK_PATH_PREFIX)) return BACKOFFICE_DOMAIN.CALLBACK;
  return BACKOFFICE_DOMAIN.ADMIN;
}

/** 取某域的错误码表（四个表结构一致，可直接按域索引）。 */
export function backofficeErrorCodesFor(
  domain: BackofficeDomain,
): BackofficeErrorTable & Record<string, string> {
  switch (domain) {
    case BACKOFFICE_DOMAIN.SHOP:
      return SHOP_ERROR_CODES;
    case BACKOFFICE_DOMAIN.MERCHANT:
      return MERCHANT_ERROR_CODES;
    case BACKOFFICE_DOMAIN.CALLBACK:
      return CALLBACK_ERROR_CODES;
    default:
      return ADMIN_ERROR_CODES;
  }
}

/** 按路径取该域的错误码表（`notFound` / `onError` 分流用）。 */
export function backofficeErrorCodesForPath(
  path: string,
): BackofficeErrorTable & Record<string, string> {
  return backofficeErrorCodesFor(backofficeDomainForPath(path));
}

/** 字符串错误码 Zod schema（非 Agent 组响应体校验用）。 */
export const BackofficeErrorCodeSchema = z.string().regex(/^ERR_[A-Z0-9_]+$/, {
  message: "后台组错误码须为 ERR_<域>_<原因> 形式",
});
