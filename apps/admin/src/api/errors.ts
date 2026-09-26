/**
 * 后台组字符串错误码（`docs/06` §6）。
 *
 * **错误码类型按路由组区分**：`/api/v1/agent/*` 用**整数**码（见 `packages/shared/src/errors.ts`
 * 的 `AGENT_ERROR_CODES`）；`shop` / `admin` / `merchant` 三组用**字符串**码，两组不混用。
 *
 * ⚠️ `packages/shared` 目前**只落了 Agent 组的整数码表**，后台组字符串码表尚未落到契约中心。
 * 本文件是后台侧的临时登记处，取值来源：
 * - `docs/06` §6 正文举例：`ORDER_STOCK_NOT_ENOUGH`、`AGENT_TOKEN_INVALID`
 * - `docs/09` §9.1 / §9.2 的认证与权限语义（登录失败、TOTP、权限不足）
 * - `apps/api` 后台路由现状
 *
 * 待 `packages/shared` 补齐字符串码表后，本文件应改为 re-export，避免两处漂移。
 */

/** 后台组（shop / admin / merchant）字符串错误码。 */
export const ADMIN_ERROR_CODES = {
  /** 成功（与整数码 `0` 等价）。 */
  OK: "OK",
  /** 参数校验失败。 */
  INVALID_PARAM: "INVALID_PARAM",
  /** 未登录 / 登录状态失效。 */
  UNAUTHORIZED: "UNAUTHORIZED",
  /** 已登录但权限点不足（`requirePerm()` 拦截）。 */
  FORBIDDEN: "FORBIDDEN",
  /** 资源不存在。 */
  NOT_FOUND: "NOT_FOUND",
  /** 状态冲突或幂等冲突。 */
  CONFLICT: "CONFLICT",
  /** 触发限流。 */
  RATE_LIMITED: "RATE_LIMITED",
  /** 服务内部错误。 */
  INTERNAL_ERROR: "INTERNAL_ERROR",
  /** 需要动态验证码（TOTP 二次确认）。 */
  TOTP_REQUIRED: "TOTP_REQUIRED",
  /** 动态验证码错误。 */
  TOTP_INVALID: "TOTP_INVALID",
  /** 账号锁定（连续失败 5 次锁定 15 分钟，`docs/09` §9.1）。 */
  ACCOUNT_LOCKED: "ACCOUNT_LOCKED",
  /** 下单库存不足（`docs/06` §6 正文举例）。 */
  ORDER_STOCK_NOT_ENOUGH: "ORDER_STOCK_NOT_ENOUGH",
  /** Agent 服务令牌无效（`docs/06` §6 正文举例）。 */
  AGENT_TOKEN_INVALID: "AGENT_TOKEN_INVALID",
  /** 售后政策内容不合法（缺分类 / 缺正文 / 版本号冲突）。 */
  AFTERSALE_POLICY_INVALID: "AFTERSALE_POLICY_INVALID",
  /** 未登录 / 登录状态失效（后台组字符串码，等价于 Agent 组的 `40101`）。 */
  TOKEN_MISSING_OR_INVALID: "TOKEN_MISSING_OR_INVALID",
  /** 令牌已吊销或已过期（等价于 Agent 组的 `40102`）。 */
  TOKEN_REVOKED: "TOKEN_REVOKED",
  /** 售后单状态不允许当前操作（`docs/08` §8.4 状态机）。 */
  AFTERSALE_STATE_CONFLICT: "AFTERSALE_STATE_CONFLICT",
} as const;

export type AdminErrorCode = (typeof ADMIN_ERROR_CODES)[keyof typeof ADMIN_ERROR_CODES];

/** 字符串错误码 → 中文文案。 */
export const ADMIN_ERROR_TEXT: Record<AdminErrorCode, string> = {
  [ADMIN_ERROR_CODES.OK]: "成功",
  [ADMIN_ERROR_CODES.INVALID_PARAM]: "参数不合法",
  [ADMIN_ERROR_CODES.UNAUTHORIZED]: "未登录或登录已过期",
  [ADMIN_ERROR_CODES.FORBIDDEN]: "没有该操作的权限",
  [ADMIN_ERROR_CODES.NOT_FOUND]: "资源不存在",
  [ADMIN_ERROR_CODES.CONFLICT]: "状态冲突，请刷新后重试",
  [ADMIN_ERROR_CODES.RATE_LIMITED]: "操作过于频繁，请稍后重试",
  [ADMIN_ERROR_CODES.INTERNAL_ERROR]: "服务内部错误",
  [ADMIN_ERROR_CODES.TOTP_REQUIRED]: "需要动态验证码（TOTP）",
  [ADMIN_ERROR_CODES.TOTP_INVALID]: "动态验证码错误",
  [ADMIN_ERROR_CODES.ACCOUNT_LOCKED]: "账号已锁定，请稍后重试",
  [ADMIN_ERROR_CODES.ORDER_STOCK_NOT_ENOUGH]: "库存不足，下单失败",
  [ADMIN_ERROR_CODES.AGENT_TOKEN_INVALID]: "服务令牌无效",
  [ADMIN_ERROR_CODES.AFTERSALE_POLICY_INVALID]: "售后政策内容不合法",
  [ADMIN_ERROR_CODES.AFTERSALE_STATE_CONFLICT]: "售后单当前状态不允许该操作",
  [ADMIN_ERROR_CODES.TOKEN_MISSING_OR_INVALID]: "未登录或登录已过期",
  [ADMIN_ERROR_CODES.TOKEN_REVOKED]: "登录状态已失效，请重新登录",
};

/**
 * 错误码所属路由组（`docs/06` §6）。
 *
 * - `"ok"`：成功（整数 `0` 或字符串 `OK`）
 * - `"admin"`：后台组**字符串**码
 * - `"agent"`：Agent 组**整数**码
 * - `"unknown"`：两者都不是（契约外取值，UI 按通用失败处理）
 */
export type ErrorGroup = "ok" | "admin" | "agent" | "unknown";

/** 判定成功码。 */
export function isOkCode(code: string | number): boolean {
  return code === 0 || code === "0" || code === ADMIN_ERROR_CODES.OK;
}

/**
 * 错误码分流：按**类型**区分路由组，而不是按数值区间猜。
 *
 * 这条规则直接来自 `docs/06` §6：「整数错误码仅用于 `/api/v1/agent/*`；
 * 字符串错误码仅用于 shop / admin / merchant 三组，两组不混用」。
 */
export function classifyErrorCode(code: string | number): ErrorGroup {
  if (isOkCode(code)) return "ok";
  if (typeof code === "string") return "admin";
  if (typeof code === "number") return "agent";
  return "unknown";
}

/** 字符串码是否为已登记的后台组错误码。 */
export function isKnownAdminErrorCode(code: string): code is AdminErrorCode {
  return Object.prototype.hasOwnProperty.call(ADMIN_ERROR_TEXT, code);
}

/**
 * 取错误码的可读文案。
 *
 * 优先级：后台组已知字符串码的中文映射 → 后端返回的 `message` → 兜底文案。
 * Agent 组整数码不走本函数（后台界面不会收到 Agent 组响应）。
 */
export function describeErrorCode(code: string | number, serverMessage?: string): string {
  const fallback =
    serverMessage !== undefined && serverMessage.length > 0 ? serverMessage : "请求失败";
  if (typeof code === "string" && isKnownAdminErrorCode(code)) {
    return ADMIN_ERROR_TEXT[code];
  }
  return fallback;
}
