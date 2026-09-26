/**
 * 支付回调仓储（`/api/v1/callbacks/*`，`docs/08` §8.2 的支付回调时序）。
 *
 * ## 幂等锚点：`payments.channel_trade_no` 的唯一约束
 *
 * `docs/08` §8.2 的时序是「验签 + `channel_trade_no` 唯一约束幂等校验 →
 * `payments` 置 paid → 主单 `PAID` → 锁定转实扣 → 子单 `PAID` → 返回 SUCCESS」。
 * 本模块把「记账」压成**一次 `db.batch()`**（D1 batch 具备原子语义），
 * 并以 `uq_payments_trade_no` 唯一索引作为**并发重复回调的唯一兜底**：
 *
 * - 已存在同 `channel_trade_no` 的 `payments` 行 → 返回 `"duplicate"`，
 *   **不重复记账、不重复扣库存**（渠道重试是常态，不是错误）；
 * - 并发两条同时插入 → 其中一条撞唯一索引失败 → 同样返回 `"duplicate"`。
 *
 * ## `payments.pay_no` 的唯一性
 *
 * `pay_no` 形如 `PAY<14 位 UTC+8 时间><3 位当秒序列>`（`@dshop/shared` 的
 * `formatPayNo()`），同秒内序列需唯一。序列为随机取值，撞号时整批失败并重试
 * （整批失败即「什么都没写」，重试安全）。
 */

import { PAYMENT_STATUS, formatPayNo, newId } from "@dshop/shared";
import type { PaymentChannel, PaymentStatus } from "@dshop/shared";

/* -------------------------------------------------------------------------- */
/* 行类型                                                                       */
/* -------------------------------------------------------------------------- */

/** 回调所需的最小 `orders` 行。 */
export interface CallbackOrderRow {
  readonly id: string;
  readonly order_no: string;
  readonly status: string;
  readonly pay_amount: number;
}

/** 幂等判定所需的最小 `payments` 行。 */
export interface CallbackPaymentRow {
  readonly id: string;
  readonly pay_no: string;
  readonly order_id: string;
  readonly channel_trade_no: string;
  readonly amount: number;
  readonly status: PaymentStatus;
}

/** 记账入参。 */
export interface ApplyPaymentSuccessInput {
  readonly orderId: string;
  readonly channel: PaymentChannel;
  readonly channelTradeNo: string;
  /** 实收金额（分），须已与 `orders.pay_amount` 比对通过。 */
  readonly amount: number;
  /** 渠道支付完成时刻（UTC ISO-8601）。 */
  readonly paidAt: string;
  /** 回调原文（解密后的业务报文 JSON），落 `payments.raw_callback`。 */
  readonly rawCallback: string;
  readonly nowIso: string;
}

/** 记账结果。 */
export type ApplyPaymentResult = "applied" | "duplicate";

/** `channel_trade_no` 已绑定到**另一订单**（唯一约束冲突的真实冲突场景）。 */
export class TradeNoConflictError extends Error {
  constructor(tradeNo: string) {
    super(`渠道交易号已被另一订单占用：${tradeNo}`);
    this.name = "TradeNoConflictError";
  }
}

/* -------------------------------------------------------------------------- */
/* 查询                                                                        */
/* -------------------------------------------------------------------------- */

/** 按 `orders.order_no` 取主单；查不到返回 `null`（路由回 `ERR_CALLBACK_NOT_FOUND`）。 */
export async function findOrderForCallback(
  db: D1Database,
  orderNo: string,
): Promise<CallbackOrderRow | null> {
  return await db
    .prepare("SELECT id, order_no, status, pay_amount FROM orders WHERE order_no = ? LIMIT 1")
    .bind(orderNo)
    .first<CallbackOrderRow>();
}

/** 按 `channel_trade_no` 取支付流水（幂等判据）。 */
export async function findPaymentByChannelTradeNo(
  db: D1Database,
  channelTradeNo: string,
): Promise<CallbackPaymentRow | null> {
  return await db
    .prepare(
      `SELECT id, pay_no, order_id, channel_trade_no, amount, status
         FROM payments WHERE channel_trade_no = ? LIMIT 1`,
    )
    .bind(channelTradeNo)
    .first<CallbackPaymentRow>();
}

/* -------------------------------------------------------------------------- */
/* 记账                                                                        */
/* -------------------------------------------------------------------------- */

/** 判断 D1 报错是否为 `payments.channel_trade_no` 唯一索引冲突。 */
function isTradeNoConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /uq_payments_trade_no|channel_trade_no/i.test(message) && /unique|constraint/i.test(message)
  );
}

/** 判断 D1 报错是否为 `payments.pay_no` 唯一索引冲突。 */
function isPayNoConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /uq_payments_no|pay_no/i.test(message) && /unique|constraint/i.test(message);
}

/** 随机当秒序列（`1`–`999`），撞号由调用方重试。 */
function randomSeq(): number {
  const bytes = new Uint8Array(2);
  crypto.getRandomValues(bytes);
  return ((((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0)) % 999) + 1;
}

/** 单次记账尝试的最大重试次数（仅针对 `pay_no` 撞号）。 */
const PAY_NO_MAX_ATTEMPTS = 5;

/**
 * 支付成功记账（幂等）。
 *
 * 全部写操作在**一次 `db.batch()`** 内完成（`docs/08` §8.2 的时序）：
 *
 * 1. `INSERT payments`（`status = 'PAID'`，`channel_trade_no` 唯一约束即幂等锚点）
 * 2. `UPDATE orders` → `PAID` + `paid_at`（仅当仍为 `PENDING_PAYMENT`）
 * 3. `UPDATE sub_orders` → `PAID`（待发货）
 * 4. `UPDATE product_skus`：**锁定转实扣**（`stock -= q` 且 `locked_stock -= q`，`docs/05` §5.3①）
 * 5. `INSERT order_status_logs`（`PENDING_PAYMENT → PAID`，`actor_type = 'system'`）
 *
 * 第 4 步用单条带子查询的 `UPDATE` 完成全部 SKU 的实扣，避免 N+1。
 *
 * @throws TradeNoConflictError 同 `channel_trade_no` 已绑定到**另一订单**
 */
export async function applyPaymentSuccess(
  db: D1Database,
  input: ApplyPaymentSuccessInput,
): Promise<ApplyPaymentResult> {
  // 先做一次读判（覆盖「渠道重复回调」这一最常见路径，且能识别真实冲突）
  const existing = await findPaymentByChannelTradeNo(db, input.channelTradeNo);
  if (existing !== null) {
    if (existing.order_id !== input.orderId) {
      throw new TradeNoConflictError(input.channelTradeNo);
    }
    return "duplicate";
  }

  for (let attempt = 0; attempt < PAY_NO_MAX_ATTEMPTS; attempt += 1) {
    const payNo = formatPayNo(new Date(input.nowIso), randomSeq());
    const logId = newId();

    const statements = [
      db
        .prepare(
          `INSERT INTO payments
             (id, pay_no, order_id, channel, channel_trade_no, amount, status, paid_at,
              raw_callback, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          newId(),
          payNo,
          input.orderId,
          input.channel,
          input.channelTradeNo,
          input.amount,
          PAYMENT_STATUS.PAID,
          input.paidAt,
          input.rawCallback,
          input.nowIso,
          input.nowIso,
        ),
      db
        .prepare(
          `UPDATE orders
              SET status = 'PAID', paid_at = ?, updated_at = ?
            WHERE id = ? AND status = 'PENDING_PAYMENT'`,
        )
        .bind(input.paidAt, input.nowIso, input.orderId),
      db
        .prepare(
          `UPDATE sub_orders SET status = 'PAID', updated_at = ?
            WHERE order_id = ? AND status != 'CANCELLED'`,
        )
        .bind(input.nowIso, input.orderId),
      // 锁定转实扣：stock -= q 且 locked_stock -= q（同一 sku 的多行 items 先求和）
      db
        .prepare(
          `UPDATE product_skus
              SET stock = MAX(stock - (
                    SELECT COALESCE(SUM(i.quantity), 0) FROM order_items i
                     WHERE i.sku_id = product_skus.id AND i.order_id = ?), 0),
                  locked_stock = MAX(locked_stock - (
                    SELECT COALESCE(SUM(i.quantity), 0) FROM order_items i
                     WHERE i.sku_id = product_skus.id AND i.order_id = ?), 0),
                  updated_at = ?
            WHERE id IN (SELECT DISTINCT i.sku_id FROM order_items i WHERE i.order_id = ?)`,
        )
        .bind(input.orderId, input.orderId, input.nowIso, input.orderId),
      db
        .prepare(
          `INSERT INTO order_status_logs
             (id, order_id, sub_order_id, kind, from_status, to_status, actor_type,
              actor_id, remark, occurred_at, created_at)
           VALUES (?, ?, NULL, 'status', 'PENDING_PAYMENT', 'PAID', 'system',
                   NULL, ?, ?, ?)`,
        )
        .bind(logId, input.orderId, "支付回调成功（锁定转实扣）", input.paidAt, input.nowIso),
    ];

    try {
      await db.batch(statements);
      return "applied";
    } catch (error) {
      // 并发重复回调：另一条请求已插入同 channel_trade_no → 幂等成功
      if (isTradeNoConflict(error)) return "duplicate";
      // pay_no 撞号：整批未生效，换序列重试
      if (isPayNoConflict(error)) continue;
      throw error;
    }
  }

  throw new Error("payments.pay_no 连续撞号，回调记账放弃（请检查当秒并发量）");
}
