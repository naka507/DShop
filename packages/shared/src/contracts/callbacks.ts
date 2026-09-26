/**
 * 支付回调契约（`/api/v1/callbacks/*`，契约中心，零业务逻辑）。
 *
 * 权威来源：
 * - `docs/06-API路由命名空间.md` §6：「`/api/v1/callbacks/...` 支付/开放平台回调
 *   （**验签，无鉴权**）」
 * - `docs/08-核心业务流程.md` §8.2（支付回调时序：验签 + `channel_trade_no`
 *   唯一约束幂等校验 → `payments.paid` → 锁定转实扣 → 返回 `SUCCESS`）
 * - `docs/09-认证权限与部署.md` §9.1（回调**不**走 JWT / 服务令牌）
 * - `packages/db/src/schema/trade.ts` 的 `payments` / `refunds` / `idempotency_keys` 列名
 *
 * ## 三条硬性约束
 *
 * 1. **无鉴权**：回调方是支付渠道服务器，不带 Cookie / Bearer / 服务令牌；安全完全依赖
 *    **验签**（微信支付 v3 的 `Wechatpay-Signature` 等四个头；支付宝的 `sign` 字段）。
 *    验签失败一律 `ERR_CALLBACK_SIGNATURE_INVALID`（`401`），**不返回任何业务细节**。
 * 2. **响应体是渠道规定形状**，不是统一信封：微信支付 v3 要求 `{ code, message }`
 *    （`code` 为字符串 `"SUCCESS"` 才算成功，否则渠道会重试）；支付宝要求
 *    纯文本 `success` / `failure`。故本文件**不**复用 `{ code, message, data }` 信封。
 * 3. **幂等锚点是 `payments.channel_trade_no` 的唯一约束**（`docs/08` §8.2）：
 *    重复回调必须返回与首次相同的成功响应，**绝不重复扣减库存 / 重复记账**。
 *
 * ⚠️ 本组错误码为**字符串**（`CALLBACK_ERROR_CODES`，`ERR_CALLBACK_*`），
 * 与 Agent 组的整数码严格分离（`docs/README.md:34`）。
 *
 * ## 路径口径
 *
 * 任务口径为 `POST /callbacks/payment/wechat` 与 `POST /callbacks/payment/alipay`
 * （见 `CALLBACK_ENDPOINTS`）；`docs/06` §6 的路由示例写作
 * `/api/v1/callbacks/wechat-pay` 与 `/api/v1/callbacks/alipay`，两者在
 * `CALLBACK_DOC_ALIAS_PATHS` 中并列登记，供路由注册时按需挂载（同 handler，双路径）。
 */

import { z } from "zod";
import { PAYMENT_CHANNEL } from "../enums.js";
import { OrderNoSchema, PayNoSchema } from "../ids.js";
import { HTTP_METHOD, IsoDateTimeSchema, MoneySchema } from "./common.js";
import type { HttpMethod } from "./common.js";

/** 微信支付 v3 回调成功响应码（`code` 字段值，渠道据此停止重试）。 */
export const WECHATPAY_SUCCESS_CODE = "SUCCESS";

/** 微信支付 v3 回调失败响应码。 */
export const WECHATPAY_FAIL_CODE = "FAIL";

/** 支付宝异步通知的成功应答正文（纯文本，非 JSON）。 */
export const ALIPAY_SUCCESS_TEXT = "success";

/** 支付宝异步通知的失败应答正文。 */
export const ALIPAY_FAILURE_TEXT = "failure";

/**
 * 微信支付 v3 回调的**四个验签相关请求头**。
 *
 * 验签步骤（微信支付 v3 规范）：拼装
 * `timestamp\nnonce\nbody\n`，用平台证书公钥验证 `signature`（`SHA256withRSA`）。
 * 任一头缺失 → `ERR_CALLBACK_SIGNATURE_MISSING`；验签不过 →
 * `ERR_CALLBACK_SIGNATURE_INVALID`；`timestamp` 超出容忍窗口（默认 5 分钟）→
 * `ERR_CALLBACK_TIMESTAMP_EXPIRED`。
 */
export const WECHATPAY_SIGNATURE_HEADERS = {
  /** 时间戳（秒）。 */
  TIMESTAMP: "Wechatpay-Timestamp",
  /** 随机串。 */
  NONCE: "Wechatpay-Nonce",
  /** 签名值（Base64）。 */
  SIGNATURE: "Wechatpay-Signature",
  /** 平台证书序列号（多证书轮换期用于选证书）。 */
  SERIAL: "Wechatpay-Serial",
} as const;

/** 时间戳容忍窗口（秒）：超出即视为重放，拒绝。 */
export const CALLBACK_TIMESTAMP_TOLERANCE_SECONDS = 300;

/* -------------------------------------------------------------------------- */
/* 微信支付 v3 回调                                                            */
/* -------------------------------------------------------------------------- */

/**
 * 微信支付 v3 回调报文（`resource` 为 **AES-256-GCM 加密**后的支付结果）。
 *
 * 解密后得到 `WxpayTransactionResource`；解密失败 →
 * `ERR_CALLBACK_DECRYPT_FAILED`（`400`）。
 */
export const WechatPayCallbackBodySchema = z.object({
  /** 事件类型，如 `TRANSACTION.SUCCESS`。 */
  event_type: z.string().min(1),
  /** 事件资源类型，固定 `encrypt-resource`。 */
  resource_type: z.string().min(1),
  resource: z.object({
    /** 加密算法，固定 `AEAD_AES_256_GCM`。 */
    algorithm: z.string().min(1),
    /** 密文（Base64）。 */
    ciphertext: z.string().min(1),
    /** 随机串（Base64），同时作为 GCM 的 AAD。 */
    nonce: z.string().min(1),
    /** 关联数据。 */
    associated_data: z.string(),
  }),
  /** 回调摘要（仅用于人工排查，**不作为业务判据**）。 */
  summary: z.string().optional(),
});

/** 微信回调解密后的支付结果（`payments` 表写入依据）。 */
export const WxpayTransactionResourceSchema = z.object({
  /** 微信支付订单号（→ `payments.channel_trade_no`，**幂等锚点**）。 */
  transaction_id: z.string().min(1),
  /** 商户订单号（本系统的 `orders.order_no`）。 */
  out_trade_no: OrderNoSchema,
  /** 交易状态，成功为 `SUCCESS`。 */
  trade_state: z.string().min(1),
  /** 支付金额（分）——须与 `orders.pay_amount` 一致，否则 `ERR_CALLBACK_AMOUNT_MISMATCH`。 */
  amount: z.object({
    total: MoneySchema,
    currency: z.string().min(1),
  }),
  /** 支付完成时间（RFC3339，转 UTC 后写 `payments.paid_at`）。 */
  success_time: IsoDateTimeSchema,
});

/** 微信回调成功响应体：`{ code: "SUCCESS", message: "" }`。 */
export const WechatPayCallbackAckSchema = z.object({
  code: z.literal(WECHATPAY_SUCCESS_CODE),
  message: z.string(),
});

/** 微信回调失败响应体：`{ code: "FAIL", message: <原因> }`（渠道会按策略重试）。 */
export const WechatPayCallbackFailSchema = z.object({
  code: z.literal(WECHATPAY_FAIL_CODE),
  message: z.string().min(1),
});

/* -------------------------------------------------------------------------- */
/* 支付宝异步通知                                                              */
/* -------------------------------------------------------------------------- */

/**
 * 支付宝异步通知报文。
 *
 * 验签方式：取除 `sign` / `sign_type` 外的全部字段按字典序拼成
 * `k=v&k=v`，用支付宝公钥验证 `sign`（`RSA2`）。
 */
export const AlipayCallbackBodySchema = z.object({
  /** 通知类型，如 `trade_status_sync`。 */
  notify_type: z.string().min(1),
  /** 商户订单号（本系统的 `orders.order_no`）。 */
  out_trade_no: OrderNoSchema,
  /** 支付宝交易号（→ `payments.channel_trade_no`，**幂等锚点**）。 */
  trade_no: z.string().min(1),
  /** 交易状态，`TRADE_SUCCESS` / `TRADE_FINISHED` 视为支付成功。 */
  trade_status: z.string().min(1),
  /** 实收金额，**单位元**（两位小数）——与库内「分」口径需换算后再比对。 */
  total_amount: z.string().min(1),
  /** 通知时间（`yyyy-MM-dd HH:mm:ss`，UTC+8），转 UTC 后落库。 */
  notify_time: z.string().min(1),
  /** 签名值（Base64）。 */
  sign: z.string().min(1),
  /** 签名算法，`RSA2`。 */
  sign_type: z.string().min(1),
  /** 应用 ID（校验是否本应用的通知）。 */
  app_id: z.string().min(1),
});

/** 支付宝回调响应：纯文本 `success`（成功）或 `failure`（失败）。 */
export const AlipayCallbackAckSchema = z.enum([ALIPAY_SUCCESS_TEXT, ALIPAY_FAILURE_TEXT]);

/* -------------------------------------------------------------------------- */
/* 端点清单                                                                    */
/* -------------------------------------------------------------------------- */

/** 回调端点规格：方法 + 路径模板 + 请求 / 响应 Schema。 */
export interface CallbackEndpointSpec {
  /** HTTP 方法（回调一律 `POST`）。 */
  readonly method: HttpMethod;
  /** 路径模板（**相对 `/api/v1`**）。 */
  readonly path: string;
  /** 支付渠道。 */
  readonly channel: (typeof PAYMENT_CHANNEL)[keyof typeof PAYMENT_CHANNEL];
  /** 回调请求体 Schema（解密 / 验签**之前**的原始形状）。 */
  readonly bodySchema: z.ZodType;
  /**
   * 成功响应 Schema。
   *
   * ⚠️ 渠道规定形状（微信 `{code,message}` / 支付宝纯文本），**不是**统一信封。
   */
  readonly ackSchema: z.ZodType;
  /** 是否必须验签（回调**全部**为 `true`；无鉴权，安全完全依赖验签）。 */
  readonly signatureRequired: boolean;
}

/**
 * callbacks 组端点全集。
 *
 * `path` 与 `apps/storefront/src/api/client.ts` 无关（回调由支付渠道直连），
 * 口径取自任务要求；`docs/06` §6 的别名路径见 `CALLBACK_DOC_ALIAS_PATHS`。
 */
export const CALLBACK_ENDPOINTS = {
  /** `POST /api/v1/callbacks/payment/wechat` —— 微信支付 v3 通知（验签后返回 `{code,message}`）。 */
  WECHAT_PAYMENT: {
    method: HTTP_METHOD.POST,
    path: "/callbacks/payment/wechat",
    channel: PAYMENT_CHANNEL.WECHAT,
    bodySchema: WechatPayCallbackBodySchema,
    ackSchema: WechatPayCallbackAckSchema,
    signatureRequired: true,
  },
  /** `POST /api/v1/callbacks/payment/alipay` —— 支付宝异步通知（验签后返回纯文本）。 */
  ALIPAY_PAYMENT: {
    method: HTTP_METHOD.POST,
    path: "/callbacks/payment/alipay",
    channel: PAYMENT_CHANNEL.ALIPAY,
    bodySchema: AlipayCallbackBodySchema,
    ackSchema: AlipayCallbackAckSchema,
    signatureRequired: true,
  },
} as const satisfies Record<string, CallbackEndpointSpec>;

/** callbacks 组端点列表（路由注册与契约测试共用）。 */
export const CALLBACK_ENDPOINT_LIST: readonly CallbackEndpointSpec[] =
  Object.values(CALLBACK_ENDPOINTS);

/**
 * `docs/06` §6 路由示例中的回调别名路径。
 *
 * 与 `CALLBACK_ENDPOINTS` 的路径**指向同一 handler**，仅挂载点不同；
 * 一期可二者并存（渠道配置决定实际使用哪一个）。
 */
export const CALLBACK_DOC_ALIAS_PATHS: readonly string[] = [
  "/api/v1/callbacks/wechat-pay",
  "/api/v1/callbacks/alipay",
];

/** callbacks 路由前缀（`docs/06` §6：`/api/v1/callbacks/...`）。 */
export const CALLBACK_ROUTE_PREFIX = "/api/v1/callbacks";

/** 支付单号（回调写 `payments.pay_no` 时校验用）。 */
export { PayNoSchema };
