/**
 * shop 路由组的错误码分流（`docs/06-API路由命名空间.md` §6）。
 *
 * ## 为什么单独一个文件
 *
 * `docs/06` §6 规定：**错误码类型按路由组区分**——
 * - `/api/v1/agent/*` 用**整数**错误码（`40001`/`40101`/…，定义在 `packages/shared/src/errors.ts`）；
 * - `/api/v1/shop/*`（以及 admin / merchant）用**字符串**错误码，形如 `ERR_SHOP_*`。
 *
 * 两套**不混用**，因此 C 端不能复用 Agent 组的整数错误码表。
 *
 * ## 与 `packages/shared` 的关系
 *
 * shop 组字符串错误码的权威定义在 `packages/shared/src/errors.ts`（由并行同事新增）。
 * 本模块**不复制**那份表，而是按**错误码关键字**做分流：
 * 对方新增 `ERR_SHOP_*` 常量时，这里无需同步改动，也不会因对方命名微调而失效。
 */

/** shop 组错误码前缀（`docs/06` §6 / `docs/README.md`「错误码」条目）。 */
export const SHOP_ERROR_PREFIX = "ERR_SHOP_";

/** 前端对 shop 组错误的语义分流（决定 UI 的处置方式，而非错误码本身）。 */
export const SHOP_ERROR_KIND = {
  /** 未登录 / Cookie 过期 / `aud` 不匹配（`docs/09` §9.1）。→ 跳登录页 */
  UNAUTHORIZED: "unauthorized",
  /** 已登录但无权限。 */
  FORBIDDEN: "forbidden",
  /**
   * 账号被禁用（`ERR_SHOP_ACCOUNT_DISABLED`）。
   *
   * **单独一档而非并入 UNAUTHORIZED**：重新登录**不能**解决，因此不能触发跳登录页
   * （否则会陷入「登录成功 → 又被拒 → 再跳登录」的死循环）。
   */
  ACCOUNT: "account",
  /** 资源不存在（商品下架、订单不属于当前用户等）。 */
  NOT_FOUND: "not_found",
  /** 参数校验失败（手机号格式、数量越界等）。 */
  VALIDATION: "validation",
  /** 库存不足（`ERR_SHOP_STOCK_INSUFFICIENT`，`docs/M0-实施简报.md` §5）。→ 提示改数量 */
  STOCK: "stock",
  /** 幂等冲突 / 状态不允许 / 金额不一致（`Idempotency-Key` 重复或状态机不合法）。 */
  CONFLICT: "conflict",
  /** 触发限流。→ 可重试 */
  RATE_LIMITED: "rate_limited",
  /** 服务端错误。→ 可重试 */
  SERVER: "server",
  /** 未识别（新增错误码落在这一档，不阻断流程）。 */
  UNKNOWN: "unknown",
} as const;
export type ShopErrorKind = (typeof SHOP_ERROR_KIND)[keyof typeof SHOP_ERROR_KIND];

/**
 * 关键字 → 语义的映射。
 *
 * **顺序即优先级**：越靠前越先匹配。例如 `ORDER_STATE_INVALID` 必须命中
 * `CONFLICT` 而非 `VALIDATION`，故 `CONFLICT` 排在 `VALIDATION` 之前。
 */
const KEYWORD_RULES: readonly {
  readonly kind: ShopErrorKind;
  readonly keywords: readonly string[];
}[] = [
  // ⚠️ **顺序即优先级**，且必须覆盖 `packages/shared` 的 `SHOP_ERROR_CODES` **全部 23 个键**
  // （`apps/storefront/tests/api-errors.test.ts` 有结构性断言：任一码落到 UNKNOWN 即失败）。
  // 越靠前越先匹配，因此：
  //   - `STOCK` 必须在 `CONFLICT` 前（`STOCK_INSUFFICIENT` 含 `STATE`？不含，但保守）；
  //   - `CONFLICT` 必须在 `VALIDATION` 前（`ORDER_STATE_CONFLICT` 含 `CONFLICT` 也含 `STATE`）；
  //   - `ACCOUNT` 必须在 `UNAUTHORIZED` 前（`ACCOUNT_DISABLED` 与登录态无关，
  //     若落到 UNAUTHORIZED 会触发「跳登录页」死循环）。
  {
    kind: SHOP_ERROR_KIND.STOCK,
    keywords: ["OUT_OF_STOCK", "SOLD_OUT", "STOCK_INSUFFICIENT", "STOCK"],
  },
  { kind: SHOP_ERROR_KIND.ACCOUNT, keywords: ["ACCOUNT_DISABLED", "ACCOUNT_LOCKED"] },
  { kind: SHOP_ERROR_KIND.FORBIDDEN, keywords: ["FORBIDDEN", "PERMISSION", "NOT_ALLOWED"] },
  {
    kind: SHOP_ERROR_KIND.UNAUTHORIZED,
    keywords: ["UNAUTHORIZED", "UNAUTHENTICATED", "TOKEN", "LOGIN_REQUIRED", "AUTH"],
  },
  { kind: SHOP_ERROR_KIND.RATE_LIMITED, keywords: ["RATE_LIMIT", "TOO_MANY"] },
  // `AMOUNT_MISMATCH` / `CHANNEL_UNSUPPORTED` 归 CONFLICT：都属于「请求本身合法但业务前置条件不满足」，
  // 前端语义是「提示用户而不是重试」。
  {
    kind: SHOP_ERROR_KIND.CONFLICT,
    keywords: [
      "CONFLICT",
      "IDEMPOTENCY",
      "STATE",
      "MISMATCH",
      "CHANNEL_UNSUPPORTED",
      "NOT_AVAILABLE",
    ],
  },
  { kind: SHOP_ERROR_KIND.NOT_FOUND, keywords: ["NOT_FOUND"] },
  { kind: SHOP_ERROR_KIND.VALIDATION, keywords: ["INVALID", "VALIDATION", "PARAM", "MALFORMED"] },
  { kind: SHOP_ERROR_KIND.SERVER, keywords: ["INTERNAL", "SERVER"] },
];

/**
 * 按 HTTP 状态码兜底分流（响应体里没有可用错误码时使用）。
 *
 * @param status HTTP 状态码；`0` 表示请求未能拿到响应（网络错误）。
 */
export function classifyShopHttpStatus(status: number): ShopErrorKind {
  if (status === 0) return SHOP_ERROR_KIND.SERVER;
  if (status === 401) return SHOP_ERROR_KIND.UNAUTHORIZED;
  if (status === 403) return SHOP_ERROR_KIND.FORBIDDEN;
  if (status === 404) return SHOP_ERROR_KIND.NOT_FOUND;
  if (status === 409) return SHOP_ERROR_KIND.CONFLICT;
  if (status === 422) return SHOP_ERROR_KIND.VALIDATION;
  if (status === 429) return SHOP_ERROR_KIND.RATE_LIMITED;
  if (status >= 500) return SHOP_ERROR_KIND.SERVER;
  if (status >= 400) return SHOP_ERROR_KIND.VALIDATION;
  return SHOP_ERROR_KIND.UNKNOWN;
}

/**
 * 按字符串错误码分流（`ERR_SHOP_*`）。
 *
 * 前缀会被剥掉再匹配关键字，因此 `ERR_SHOP_ORDER_STOCK_NOT_ENOUGH` 与
 * `ORDER_STOCK_NOT_ENOUGH` 得到同一结果。
 */
export function classifyShopErrorCode(code: string): ShopErrorKind {
  const normalized = code.trim().toUpperCase();
  if (normalized === "") return SHOP_ERROR_KIND.UNKNOWN;
  const bare = normalized.startsWith(SHOP_ERROR_PREFIX)
    ? normalized.slice(SHOP_ERROR_PREFIX.length)
    : normalized;
  for (const rule of KEYWORD_RULES) {
    if (rule.keywords.some((keyword) => bare.includes(keyword))) return rule.kind;
  }
  return SHOP_ERROR_KIND.UNKNOWN;
}

/** 判断统一响应体的 `code` 是否表示成功（`docs/06` §6：`code === 0` 为成功）。 */
export function isSuccessCode(code: number | string): boolean {
  if (typeof code === "number") return code === 0;
  const normalized = code.trim().toLowerCase();
  return normalized === "0" || normalized === "ok" || normalized === "success";
}

/** `ShopHttpError` 的构造入参。 */
export interface ShopHttpErrorInit {
  /** shop 组字符串错误码（`ERR_SHOP_*`）；无法取得时传空串。 */
  readonly code: string;
  readonly message: string;
  readonly status: number;
  readonly requestId?: string | null;
}

/**
 * shop 组 API 的统一错误类型。
 *
 * 所有经 `src/api/transport.ts` 发出的请求，失败时一律抛本类型，
 * 因此页面只需 `catch (error) { describeShopError(error) }`。
 */
export class ShopHttpError extends Error {
  /** 原始错误码（`ERR_SHOP_*`）。 */
  readonly code: string;
  /** HTTP 状态码；`0` 表示网络层失败。 */
  readonly status: number;
  /** 后端 `X-Request-Id`，用于与 `access_log` 对账。 */
  readonly requestId: string | null;
  /** 语义分流结果。 */
  readonly kind: ShopErrorKind;

  constructor(init: ShopHttpErrorInit) {
    super(init.message);
    this.name = "ShopHttpError";
    this.code = init.code;
    this.status = init.status;
    this.requestId = init.requestId ?? null;
    this.kind =
      init.code === "" ? classifyShopHttpStatus(init.status) : classifyShopErrorCode(init.code);
  }

  /** 是否应跳转登录（`docs/09` §9.1：Cookie 过期或 `aud` 不匹配）。 */
  get requiresLogin(): boolean {
    return this.kind === SHOP_ERROR_KIND.UNAUTHORIZED;
  }

  /** 是否值得重试（限流 / 服务端瞬时错误）。 */
  get retryable(): boolean {
    return this.kind === SHOP_ERROR_KIND.RATE_LIMITED || this.kind === SHOP_ERROR_KIND.SERVER;
  }
}

/** 类型守卫。 */
export function isShopHttpError(value: unknown): value is ShopHttpError {
  return value instanceof ShopHttpError;
}

/** 错误 → 用户可见的中文文案（页面统一用它渲染提示）。 */
export function describeShopError(error: unknown): string {
  if (error instanceof ShopHttpError) {
    switch (error.kind) {
      case SHOP_ERROR_KIND.UNAUTHORIZED:
        return "登录状态已失效，请重新登录";
      case SHOP_ERROR_KIND.FORBIDDEN:
        return "没有权限执行该操作";
      case SHOP_ERROR_KIND.NOT_FOUND:
        return "请求的内容不存在或已下架";
      case SHOP_ERROR_KIND.VALIDATION:
        return error.message === "" ? "提交的内容不合法" : error.message;
      case SHOP_ERROR_KIND.STOCK:
        return "库存不足，请调整购买数量";
      case SHOP_ERROR_KIND.CONFLICT:
        return "操作冲突或当前状态不允许，请刷新后重试";
      case SHOP_ERROR_KIND.RATE_LIMITED:
        return "操作过于频繁，请稍后再试";
      case SHOP_ERROR_KIND.SERVER:
        return "服务暂时不可用，请稍后再试";
      default:
        return error.message === "" ? "请求失败" : error.message;
    }
  }
  if (error instanceof Error) return error.message;
  return "未知错误";
}
