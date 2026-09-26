/**
 * C 端订单路由（`docs/06` §6 的 `/api/v1/shop/orders*`，`docs/08` §8.2–§8.3）。
 *
 * - `POST /shop/orders`                —— 下单（**必须**带 `Idempotency-Key`）
 * - `POST /shop/orders/:orderNo/pay`   —— 发起支付（**占位，不接渠道**）
 * - `GET  /shop/orders`                —— 列表
 * - `GET  /shop/orders/:orderNo`       —— 详情
 *
 * ## 下单的四道闸门
 *
 * 1. `Idempotency-Key` 缺失 → `ERR_SHOP_INVALID_PARAM`（400）
 * 2. 地址归属校验（`user_addresses.user_id`）→ `ERR_SHOP_ADDRESS_NOT_FOUND`
 * 3. 库存**单语句原子锁定**，`changes = 0` → `ERR_SHOP_STOCK_INSUFFICIENT`（409）
 * 4. 写库成功后清空已结算的购物车行
 *
 * 全部库存判据都在 SQL 的 `WHERE` 里，**绝无「先查再写」**（`docs/05` §5.3②）。
 */

import {
  IDEMPOTENCY_KEY_HEADER,
  ORDER_CHANNEL,
  ORDER_STATUS,
  PAYMENT_CHANNEL,
  ShopOrderCreateBodySchema,
  ShopOrderDetailSchema,
  ShopOrderListQuerySchema,
  ShopOrderListSchema,
  ShopOrderParamsSchema,
  ShopOrderPayBodySchema,
  ShopOrderPayResultSchema,
  formatOrderNo,
  formatPayNo,
  formatSubOrderNo,
  newId,
} from "@dshop/shared";
import { TASK_TYPE, getTaskQueue } from "@dshop/services";
import { Hono } from "hono";
import type { Context } from "hono";

import type { Env } from "../../env.js";
import type { AppEnv } from "../../lib/context.js";
import { successResponse } from "../../lib/errors.js";
import { deleteCartItems, listCartRows, listCartRowsByIds } from "../../repositories/shop-cart.js";
import type { ShopCartRow } from "../../repositories/shop-cart.js";
import {
  IDEMPOTENCY_SCOPE,
  beginIdempotentRequest,
  completeIdempotentRequest,
  requestFingerprintOf,
} from "../../repositories/shop-idempotency.js";
import {
  findMerchantDefaultStoreId,
  findShopOrderByNo,
  findShopOrderForPay,
  insertPaymentPlaceholder,
  insertShopOrder,
  listShopOrders,
  lockSkuStocks,
  nextOrderSeq,
  nextPaySeq,
  releaseSkuStocks,
} from "../../repositories/shop-orders.js";
import { decryptReceiverPhone, findShopAddress } from "../../repositories/shop-users.js";
import { shopError, shopInvalidParam } from "./errors.js";
import { requireShopAuth } from "./guard.js";
import { mapOrderDetail, mapOrderListItem } from "./mappers.js";

export const orderRoutes = new Hono<AppEnv & { Bindings: Env }>();

/** 子单写入计划（`insertShopOrder` 的入参形状，供本文件拼装）。 */
interface ShopOrderSubOrderPlan {
  readonly id: string;
  readonly subOrderNo: string;
  readonly merchantId: string;
  readonly storeId: string;
  readonly subtotal: number;
  readonly discountAlloc: number;
  readonly freight: number;
  readonly items: readonly {
    readonly id: string;
    readonly spuId: string;
    readonly skuId: string;
    readonly title: string;
    readonly image: string | null;
    readonly spec: string;
    readonly unitPrice: number;
    readonly quantity: number;
    readonly subtotal: number;
  }[];
}

/** 支付单笔超时（分钟）——`docs/08` §8.6 的「超时未支付关单」判据来源。 */
export const ORDER_PAY_TIMEOUT_MINUTES = 15;

/** 取当前登录用户 id。 */
function currentUserId(c: Context<AppEnv & { Bindings: Env }>): string {
  return c.get("adminSubject").sub;
}

/** 读取请求体 JSON；失败返回 `null`。 */
async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown | null> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* 下单                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * `POST /shop/orders` —— 下单。
 *
 * ⚠️ `Idempotency-Key` **必须**携带（`docs/06` §6）。重放时**直接返回首次结果**
 * （`docs/05` §5.3③「下单」行：「重放直接返回首次结果」）。
 * 同 key 不同请求体 → `ERR_SHOP_IDEMPOTENCY_CONFLICT`（409）。
 */
orderRoutes.post("/orders", requireShopAuth(), async (c) => {
  const userId = currentUserId(c);

  // ① 幂等键
  const idempotencyKey = c.req.header(IDEMPOTENCY_KEY_HEADER);
  if (idempotencyKey === undefined || idempotencyKey.trim().length === 0) {
    return shopInvalidParam(`缺少 ${IDEMPOTENCY_KEY_HEADER} 请求头`);
  }

  const raw = await readJson(c);
  if (raw === null) return shopInvalidParam("请求体不是合法 JSON");

  const body = ShopOrderCreateBodySchema.safeParse(raw);
  if (!body.success) return shopInvalidParam("addressId / itemIds / remark 非法");

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const fingerprint = requestFingerprintOf(body.data);

  const outcome = await beginIdempotentRequest<unknown>(c.env.DB, {
    scope: IDEMPOTENCY_SCOPE.SHOP_ORDER_CREATE,
    key: idempotencyKey,
    requestHash: fingerprint,
    newId: newId(),
    nowMs,
  });

  if (outcome.kind === "conflict") {
    return shopError("IDEMPOTENCY_CONFLICT", outcome.reason);
  }
  if (outcome.kind === "replay") {
    const validated = ShopOrderDetailSchema.safeParse(outcome.response);
    if (!validated.success) {
      return shopError("INTERNAL_ERROR", "幂等重放的首次结果不符合契约");
    }
    return successResponse(validated.data);
  }

  // ② 地址归属
  const address = await findShopAddress(c.env.DB, userId, body.data.addressId);
  if (address === null) return shopError("ADDRESS_NOT_FOUND", "收货地址不存在");

  // ③ 取待结算的购物车行（指定行 → 只取那些行；省略 → 整车）
  const cartRows: readonly ShopCartRow[] =
    body.data.itemIds === undefined || body.data.itemIds.length === 0
      ? await listCartRows(c.env.DB, userId)
      : await listCartRowsByIds(c.env.DB, userId, body.data.itemIds);

  if (cartRows.length === 0) {
    return shopInvalidParam("购物车为空，无可结算商品");
  }
  const unavailable = cartRows.find((row) => !isRowPurchasable(row));
  if (unavailable !== undefined) {
    return shopError("PRODUCT_NOT_AVAILABLE", `商品不可购买：${unavailable.sku_id}`);
  }

  // ④ 按商户拆子单（`docs/05` §5.3①），子单号从 `-01` 起
  const groups = groupCartRowsByMerchant(cartRows);
  const orderId = newId();
  const orderNo = formatOrderNo(
    new Date(nowMs),
    await nextOrderSeq(c.env.DB, orderNoPrefix(nowMs)),
  );

  const subOrderPlans: ShopOrderSubOrderPlan[] = [];

  let subOrderIndex = 0;
  for (const [merchantId, rows] of groups.entries()) {
    const storeId = await findMerchantDefaultStoreId(c.env.DB, merchantId);
    if (storeId === null) {
      // 缺履约节点是**数据配置问题**（`docs/08` §8.5），不是用户输入问题
      return shopError("INTERNAL_ERROR", `商户 ${merchantId} 无启用门店，无法履约`);
    }
    subOrderIndex += 1;
    const priced = rows.map((row) => ({
      row,
      unitPrice: row.price ?? 0,
      spuId: row.product_id ?? row.sku_id,
      title: row.title ?? "商品已下架",
    }));
    subOrderPlans.push({
      id: newId(),
      subOrderNo: formatSubOrderNo(orderNo, subOrderIndex),
      merchantId,
      storeId,
      subtotal: priced.reduce((sum, item) => sum + item.unitPrice * item.row.quantity, 0),
      discountAlloc: 0,
      freight: 0,
      items: priced.map((item) => ({
        id: newId(),
        spuId: item.spuId,
        skuId: item.row.sku_id,
        title: item.title,
        image: null,
        spec: item.row.spec ?? "{}",
        unitPrice: item.unitPrice,
        quantity: item.row.quantity,
        subtotal: item.unitPrice * item.row.quantity,
      })),
    });
  }

  const totalAmount = subOrderPlans.reduce((sum, sub) => sum + sub.subtotal, 0);
  // ⚠️ 运费与优惠恒为 0（占位，见 `mappers.ts` 的 `mapCheckoutPreview` 缺口说明）
  const payAmount = totalAmount;

  // 支付截止时刻（`docs/08` §8.6）：下单时刻 + 支付期限。
  // ⚠️ **只算一次**：下面的订单写入与入队延迟都用这一个值，
  // 避免「两处各算一套」导致任务触发时刻与 `pay_deadline` 漂移。
  const payDeadlineIso = new Date(nowMs + ORDER_PAY_TIMEOUT_MINUTES * 60_000).toISOString();

  // ⑤ 库存**单语句原子锁定**（`docs/05` §5.3②）
  const locks = cartRows.map((row) => ({ skuId: row.sku_id, quantity: row.quantity }));
  const failedSku = await lockSkuStocks(c.env.DB, locks);
  if (failedSku !== null) {
    return shopError("STOCK_INSUFFICIENT", `库存不足：${failedSku}`);
  }

  // ⑥ 写库（锁成功后才写；写失败则补偿释放）
  try {
    await insertShopOrder(c.env.DB, {
      orderId,
      orderNo,
      userId,
      totalAmount,
      discountAmount: 0,
      freightAmount: 0,
      payAmount,
      addressSnapshot: JSON.stringify({
        receiver_name: address.receiver_name,
        receiver_phone: await decryptReceiverPhone(c.env.PHONE_ENC_KEY, address.receiver_phone),
        province: address.province,
        city: address.city,
        district: address.district,
        detail: address.detail,
      }),
      channel: ORDER_CHANNEL.WEB,
      remark: body.data.remark ?? null,
      payDeadline: payDeadlineIso,
      nowIso,
      subOrders: subOrderPlans,
    });
  } catch (error) {
    await releaseSkuStocks(c.env.DB, locks);
    throw error;
  }

  // ⑦ 清空已结算的购物车行
  await deleteCartItems(
    c.env.DB,
    userId,
    cartRows.map((row) => row.id),
  );

  const aggregate = await findShopOrderByNo(c.env.DB, userId, orderNo);
  if (aggregate === null) return shopError("INTERNAL_ERROR", "下单成功但查不到订单");

  const detail = ShopOrderDetailSchema.safeParse(mapOrderDetail(aggregate));
  if (!detail.success) return shopError("INTERNAL_ERROR", "订单详情响应不符合契约");

  // 落幂等结果：后续同 key 重放直接返回该响应
  await completeIdempotentRequest(c.env.DB, {
    scope: IDEMPOTENCY_SCOPE.SHOP_ORDER_CREATE,
    key: idempotencyKey,
    responseBody: JSON.stringify(detail.data),
  });

  /*
   * ⑧ 入队「超时未支付关单」任务（升级缝 S1，`docs/04` §4.3 / `docs/12` §12.9.3）。
   *
   * 这是 S1 的**生产者调用点**：默认走 D1 `task_queue` 表 + Cron 轮询消费；加
   * `TASK_QUEUE` 绑定后由 Cloudflare Queues 接手，**本行代码不变**。
   *
   * ★ **`delaySeconds` = 支付期限剩余秒数**（传输层延迟）：让任务在 `pay_deadline`
   *   之后才可被消费。Cron 路径写 `run_at`、Queues 路径透传原生 `delaySeconds`，
   *   两条路径都因此不再「下单约 1 分钟后就把未支付订单关掉」。
   *   ⚠️ 这只是**削峰**：真正的正确性保证在消费端——handler 会二次校验
   *   `orders.pay_deadline`，未到期就重排（`jobs/task-queue.ts` 的 `TaskResult`）。
   *
   * ⚠️ **入队失败不能让下单失败**：入队是「尽力而为」的削峰手段，
   * 不属于下单事务的一部分——订单已落库且库存已锁定，此时返回失败反而
   * 会让用户重试下单（重复锁定）。因此这里 try/catch 吞掉异常并告警留痕；
   * 代价是极端情况下该订单不会被自动关单，需人工排查（关单没有独立的扫描器，
   * 判据只有本任务 + handler 的 `pay_deadline` 二次校验）。
   */
  try {
    // 复用上面那个 `payDeadlineIso`（**不重新算一套**）：剩余秒数即传输层延迟。
    // `Math.ceil` 保证「不足 1 秒的余量」也至少延后 1 秒（不会提前触发）。
    const delaySeconds = Math.max(
      0,
      Math.ceil((Date.parse(payDeadlineIso) - nowMs) / 1000),
    );
    await getTaskQueue(c.env).enqueue(
      TASK_TYPE.ORDER_TIMEOUT_CANCEL,
      {
        orderId,
        orderNo,
        createdAtMs: nowMs,
      },
      { delaySeconds },
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "task_enqueue_failed",
        taskType: TASK_TYPE.ORDER_TIMEOUT_CANCEL,
        orderNo,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  return successResponse(detail.data);
});

/* -------------------------------------------------------------------------- */
/* 支付（占位）                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * `POST /shop/orders/:orderNo/pay` —— 发起支付。
 *
 * ⚠️ **只创建支付单占位行并返回渠道参数占位**，**不接**微信 / 支付宝 SDK：
 * `docs/08` §8.2 的「渠道下单 → 回调 → 锁定转实扣」链路由 callbacks 组
 * 与后续里程碑实现。`params` 里的键是**占位串**，前端不可据此发起真实支付。
 */
orderRoutes.post("/orders/:orderNo/pay", requireShopAuth(), async (c) => {
  const params = ShopOrderParamsSchema.safeParse({ orderNo: c.req.param("orderNo") });
  if (!params.success) return shopInvalidParam("orderNo 格式非法（须为 ^DS\\d{17}$）");

  const raw = await readJson(c);
  if (raw === null) return shopInvalidParam("请求体不是合法 JSON");

  const body = ShopOrderPayBodySchema.safeParse(raw);
  if (!body.success) return shopInvalidParam("channel 非法（须为 wechat 或 alipay）");

  const userId = currentUserId(c);
  const order = await findShopOrderForPay(c.env.DB, userId, params.data.orderNo);
  if (order === null) return shopError("ORDER_NOT_FOUND", "订单不存在");

  // 只有待支付的订单可发起支付（`docs/08` §8.3 状态机）
  if (order.status !== ORDER_STATUS.PENDING_PAYMENT) {
    return shopError("ORDER_STATE_CONFLICT", "订单当前状态不允许发起支付");
  }

  const nowMs = Date.now();
  const payNo = formatPayNo(new Date(nowMs), await nextPaySeq(c.env.DB, payNoPrefix(nowMs)));
  await insertPaymentPlaceholder(c.env.DB, {
    id: newId(),
    payNo,
    orderId: order.id,
    channel: body.data.channel,
    amount: order.pay_amount,
    nowIso: new Date(nowMs).toISOString(),
  });

  const result = ShopOrderPayResultSchema.safeParse({
    payNo,
    channel: body.data.channel,
    params: paymentParamsPlaceholder(body.data.channel, payNo),
  });
  if (!result.success) return shopError("INTERNAL_ERROR", "支付参数响应不符合契约");

  return successResponse(result.data);
});

/* -------------------------------------------------------------------------- */
/* 读                                                                          */
/* -------------------------------------------------------------------------- */

/** `GET /shop/orders` —— 订单列表（后台组统一分页）。 */
orderRoutes.get("/orders", requireShopAuth(), async (c) => {
  const parsed = ShopOrderListQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return shopInvalidParam("查询参数非法（status / page / pageSize）");

  const userId = currentUserId(c);
  const result = await listShopOrders(c.env.DB, {
    userId,
    status: parsed.data.status,
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
  });

  const validated = ShopOrderListSchema.safeParse({
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
    total: result.total,
    list: result.rows.map(mapOrderListItem),
  });
  if (!validated.success) return shopError("INTERNAL_ERROR", "订单列表响应不符合契约");

  return successResponse(validated.data);
});

/**
 * `GET /shop/orders/:orderNo` —— 订单详情（**主单 + 子单**，`docs/08` §8.3）。
 *
 * 归属校验在 SQL 里强制；查不到即 `ERR_SHOP_ORDER_NOT_FOUND`——
 * 不区分「不存在」与「不属于你」，防枚举。
 */
orderRoutes.get("/orders/:orderNo", requireShopAuth(), async (c) => {
  const parsed = ShopOrderParamsSchema.safeParse({ orderNo: c.req.param("orderNo") });
  if (!parsed.success) return shopInvalidParam("orderNo 格式非法（须为 ^DS\\d{17}$）");

  const userId = currentUserId(c);
  const aggregate = await findShopOrderByNo(c.env.DB, userId, parsed.data.orderNo);
  if (aggregate === null) return shopError("ORDER_NOT_FOUND", "订单不存在");

  const validated = ShopOrderDetailSchema.safeParse(mapOrderDetail(aggregate));
  if (!validated.success) return shopError("INTERNAL_ERROR", "订单详情响应不符合契约");

  return successResponse(validated.data);
});

/* -------------------------------------------------------------------------- */
/* 内部                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 该购物车行是否处于**可购买状态**（下架 / 售罄 / 关联缺失都不可）。
 *
 * ⚠️ **刻意不判数量**：数量充足性**只能**由 `UPDATE ... WHERE stock - locked_stock >= ?`
 * 的单语句原子判据决定（`docs/05` §5.3②「`changes === 0` 即库存不足」）。
 * 若在这里先比一次数量，库存不足会退化成 `ERR_SHOP_PRODUCT_NOT_AVAILABLE`，
 * 掩盖真正的失败原因，也让「判据唯一」的纪律失效。
 */
function isRowPurchasable(row: ShopCartRow): boolean {
  if (row.sku_status !== "active" || row.product_status !== "onsale") return false;
  if (row.price === null || row.title === null || row.product_id === null) return false;
  return row.stock !== null && row.locked_stock !== null;
}

/** 按 `merchant_id` 分组，保持首次出现顺序（子单号 `-01` 起与用户看到的一致）。 */
function groupCartRowsByMerchant(rows: readonly ShopCartRow[]): Map<string, ShopCartRow[]> {
  const groups = new Map<string, ShopCartRow[]>();
  for (const row of rows) {
    const key = row.merchant_id ?? "";
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [row]);
    else list.push(row);
  }
  return groups;
}

/** 订单号前缀（`DS` + UTC+8 的 `YYYYMMDDHHmmss`），用于当秒序列查询。 */
function orderNoPrefix(nowMs: number): string {
  return formatOrderNo(new Date(nowMs), 1).slice(0, 16);
}

/** 支付单号前缀（`PAY` + UTC+8 的 `YYYYMMDDHHmmss`）。 */
function payNoPrefix(nowMs: number): string {
  return formatPayNo(new Date(nowMs), 1).slice(0, 17);
}

/**
 * 支付参数**占位**（**未接任何渠道**）。
 *
 * 键名对齐各渠道的常见封装（微信 Native 的 `code_url`、支付宝的 `form`），
 * 但值是**明确的占位串**，前端不得据此发起真实支付。
 */
function paymentParamsPlaceholder(
  channel: (typeof PAYMENT_CHANNEL)[keyof typeof PAYMENT_CHANNEL],
  payNo: string,
): Record<string, string> {
  if (channel === PAYMENT_CHANNEL.WECHAT) {
    return { code_url: `placeholder://wechat-pay/${payNo}`, note: "支付渠道未接入" };
  }
  return { form: `placeholder://alipay/${payNo}`, note: "支付渠道未接入" };
}
