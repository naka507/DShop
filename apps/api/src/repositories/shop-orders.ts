/**
 * C 端订单仓储（`docs/06` §6 的 `/api/v1/shop/orders*`）。
 *
 * ## 下单的原子性（`docs/05` §5.3②、`docs/08` §8.2）
 *
 * D1 **无交互式事务**，故下单分两步，且**任何一步都不做「先查再写」的库存判断**：
 *
 * 1. 用**单语句原子更新**逐 SKU 锁库存：
 *    `UPDATE product_skus SET locked_stock = locked_stock + ?
 *      WHERE id = ? AND stock - locked_stock >= ? AND status = 'active'`
 *    —— 该语句的 `changes` 即判据，0 表示可售不足。
 * 2. 锁全部成功后，用 `DB.batch()` 原子写入
 *    `orders` + `sub_orders` + `order_items` + `order_status_logs`。
 *
 * ⚠️ 与 `docs/05` §5.3② 原文的一处**实现细化**：原文说「任一语句 `changes=0`
 * 则整批回滚」，但 D1 的 `batch()` 只在**语句报错**时回滚，`changes=0` 不触发回滚。
 * 因此本实现把「锁库存」单独作为第 1 步，并在检测到 `changes=0` 时
 * **补偿释放**本批已取得的锁定，再返回 `ERR_SHOP_STOCK_INSUFFICIENT`。
 * 这既守住了「单语句原子更新」的硬要求，也守住了「不超卖、不虚占」的结果。
 *
 * ## 库存口径（三处必须一致，`docs/05` §5.3②）
 *
 * 下单**只锁**（`locked_stock += q`），支付才实扣（`stock -= q` 且 `locked_stock -= q`）。
 * **禁止**下单时同时改 `stock` 与 `locked_stock`。
 *
 * ## 支付
 *
 * ⚠️ `POST /shop/orders/:orderNo/pay` **只落 `payments` 占位行并返回渠道参数占位**，
 * **不接**微信 / 支付宝 SDK——真实渠道对接属 callbacks 组与后续里程碑
 * （`docs/08` §8.2 的「支付回调」链路）。
 */

import type { OrderChannel, OrderStatus, PaymentChannel, SubOrderStatus } from "@dshop/shared";

/* -------------------------------------------------------------------------- */
/* 行类型                                                                       */
/* -------------------------------------------------------------------------- */

/** `orders` 行（含 `address_snapshot`：C 端需解密后完整下发）。 */
export interface ShopOrderRow {
  readonly id: string;
  readonly order_no: string;
  readonly status: OrderStatus;
  readonly total_amount: number;
  readonly discount_amount: number;
  readonly freight_amount: number;
  readonly pay_amount: number;
  readonly address_snapshot: string;
  readonly channel: OrderChannel;
  readonly paid_at: string | null;
  readonly created_at: string;
}

/** `sub_orders` 行 + 商户 / 门店展示列。 */
export interface ShopSubOrderRow {
  readonly id: string;
  readonly sub_order_no: string;
  readonly order_id: string;
  readonly merchant_id: string;
  readonly store_id: string;
  readonly status: SubOrderStatus;
  readonly express_company: string | null;
  readonly express_company_code: string | null;
  readonly express_no: string | null;
  readonly shipped_at: string | null;
  readonly merchant_name: string | null;
  readonly merchant_type: string | null;
  readonly store_name: string | null;
  readonly store_city: string | null;
  readonly store_province: string | null;
}

/** `order_items` 行（下单快照）。 */
export interface ShopOrderItemRow {
  readonly id: string;
  readonly sub_order_id: string;
  readonly sku_id: string;
  readonly title: string;
  readonly spec: string;
  readonly unit_price: number;
  readonly quantity: number;
  readonly subtotal: number;
}

/** 订单列表项聚合体。 */
export interface ShopOrderListAggregate {
  readonly order: ShopOrderRow;
  readonly subOrderStatuses: readonly SubOrderStatus[];
  readonly items: readonly ShopOrderItemRow[];
  readonly aftersales: readonly { readonly status: string; readonly refund_amount: number }[];
}

/** 订单列表结果（后台组统一分页：`{ page, pageSize, total, list }`）。 */
export interface ShopOrderListResult {
  readonly rows: readonly ShopOrderListAggregate[];
  readonly total: number;
}

/** 订单详情聚合体。 */
export interface ShopOrderDetailAggregate {
  readonly order: ShopOrderRow;
  readonly subOrders: readonly ShopSubOrderRow[];
  readonly items: readonly ShopOrderItemRow[];
  readonly aftersales: readonly { readonly status: string; readonly refund_amount: number }[];
}

/** 待写入的订单快照（由路由层算好金额后传入）。 */
export interface ShopOrderWriteInput {
  readonly orderId: string;
  readonly orderNo: string;
  readonly userId: string;
  readonly totalAmount: number;
  readonly discountAmount: number;
  readonly freightAmount: number;
  readonly payAmount: number;
  readonly addressSnapshot: string;
  readonly channel: OrderChannel;
  readonly remark: string | null;
  readonly payDeadline: string;
  readonly nowIso: string;
  readonly subOrders: readonly {
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
  }[];
}

/* -------------------------------------------------------------------------- */
/* SQL 片段                                                                     */
/* -------------------------------------------------------------------------- */

const ORDER_COLUMNS =
  "id, order_no, status, total_amount, discount_amount, freight_amount, pay_amount, " +
  "address_snapshot, channel, paid_at, created_at";

const SUB_ORDER_COLUMNS =
  "s.id AS id, s.sub_order_no AS sub_order_no, s.order_id AS order_id, " +
  "s.merchant_id AS merchant_id, s.store_id AS store_id, s.status AS status, " +
  "s.express_company AS express_company, s.express_company_code AS express_company_code, " +
  "s.express_no AS express_no, s.shipped_at AS shipped_at, " +
  "m.name AS merchant_name, m.type AS merchant_type, " +
  "st.name AS store_name, st.city AS store_city, st.province AS store_province";

const SUB_ORDER_FROM = `
  FROM sub_orders s
  LEFT JOIN merchants m ON m.id = s.merchant_id
  LEFT JOIN stores st ON st.id = s.store_id`;

const ORDER_ITEM_COLUMNS = "id, sub_order_id, sku_id, title, spec, unit_price, quantity, subtotal";

/** 生成 `?, ?, ...` 占位串。 */
function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

/* -------------------------------------------------------------------------- */
/* 单号生成（`docs/05` §5.3⑤ 的当秒 / 当日序列）                                */
/* -------------------------------------------------------------------------- */

/**
 * 取当秒订单序号（`formatOrderNo` 的 `seq`）。
 *
 * 实现：按已存在的 `order_no` 前缀（`DS` + 17 位时间戳）计数 +1。
 * ⚠️ 并发同秒下单可能撞 `uq_orders_no`；调用方捕获后重试一次即可
 * （D1 无交互式事务，本函数不做跨请求锁）。
 */
export async function nextOrderSeq(db: D1Database, prefix: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS total FROM orders WHERE order_no LIKE ?")
    .bind(`${prefix}%`)
    .first<{ total: number }>();
  return (row?.total ?? 0) + 1;
}

/** 取当日售后序号（`formatAftersaleNo` 的 `seq`）。 */
export async function nextAftersaleSeq(db: D1Database, prefix: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS total FROM aftersales WHERE aftersale_no LIKE ?")
    .bind(`${prefix}%`)
    .first<{ total: number }>();
  return (row?.total ?? 0) + 1;
}

/* -------------------------------------------------------------------------- */
/* 库存锁定 / 释放（单语句原子更新）                                            */
/* -------------------------------------------------------------------------- */

/**
 * 构造「锁库存」语句（**单语句原子更新**，`docs/05` §5.3②）。
 *
 * 判据写在 `WHERE` 里，**绝不先 SELECT 再 UPDATE**。`changes === 0` 即库存不足。
 */
export function lockSkuStatement(
  db: D1Database,
  skuId: string,
  quantity: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE product_skus
          SET locked_stock = locked_stock + ?
        WHERE id = ? AND stock - locked_stock >= ? AND status = 'active'`,
    )
    .bind(quantity, skuId, quantity);
}

/** 构造「释放锁定」语句（补偿用：下单失败时回补可售库存）。 */
export function releaseSkuStatement(
  db: D1Database,
  skuId: string,
  quantity: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE product_skus
          SET locked_stock = locked_stock - ?
        WHERE id = ? AND locked_stock >= ?`,
    )
    .bind(quantity, skuId, quantity);
}

/**
 * 原子锁定一批 SKU。
 *
 * @returns 全部锁定成功返回 `null`；否则返回**第一个失败**的 skuId，
 *          并在返回前**补偿释放**本批已取得的锁定（不留虚占）。
 */
export async function lockSkuStocks(
  db: D1Database,
  locks: readonly { readonly skuId: string; readonly quantity: number }[],
): Promise<string | null> {
  if (locks.length === 0) return null;

  const results = await db.batch(locks.map((l) => lockSkuStatement(db, l.skuId, l.quantity)));

  const failedIndex = results.findIndex((r) => (r.meta?.changes ?? 0) === 0);
  if (failedIndex === -1) return null;

  // 补偿：只释放**已经成功**的那些锁定（失败的那条本就没改库）
  const acquired = locks.slice(0, failedIndex);
  if (acquired.length > 0) {
    await db.batch(acquired.map((l) => releaseSkuStatement(db, l.skuId, l.quantity)));
  }
  return locks[failedIndex]?.skuId ?? null;
}

/** 释放一批锁定（下单写库阶段抛错时的补偿）。 */
export async function releaseSkuStocks(
  db: D1Database,
  locks: readonly { readonly skuId: string; readonly quantity: number }[],
): Promise<void> {
  if (locks.length === 0) return;
  await db.batch(locks.map((l) => releaseSkuStatement(db, l.skuId, l.quantity)));
}

/* -------------------------------------------------------------------------- */
/* 超时关单（`docs/08:105` 的「超时未支付关单」）                                 */
/* -------------------------------------------------------------------------- */

/** 订单状态行（超时关单的判据来源）。 */
export interface ShopOrderStatusRow {
  readonly id: string;
  readonly order_no: string;
  readonly status: OrderStatus;
  /** 支付截止时刻（ISO 8601）——handler 的二次校验判据（未到期则延后，不关单）。 */
  readonly pay_deadline: string | null;
}

/**
 * 按主单 id 取状态与支付截止时刻（超时关单消费者用）。
 *
 * ⚠️ **只用于读判**：关单的判据**不在这里**，而是由 {@link cancelUnpaidOrder}
 * 的 `batch` 内 `WHERE status = 'PENDING_PAYMENT'` 决定（`docs/05` §5.3②「判据唯一」）。
 * 这里读出的 `status` / `pay_deadline` 只用于「提前短路」与「延后到 `pay_deadline`」。
 */
export async function findOrderStatusById(
  db: D1Database,
  orderId: string,
): Promise<ShopOrderStatusRow | null> {
  return await db
    .prepare(
      "SELECT id, order_no, status, pay_deadline FROM orders WHERE id = ? LIMIT 1",
    )
    .bind(orderId)
    .first<ShopOrderStatusRow>();
}

/**
 * 超时关单（`docs/08:105`）：**关单 + 子单 + 状态日志 + 释放锁定**在**同一个
 * `db.batch()`** 里完成（D1 `batch` 是同一事务按序执行，全成功才提交）。
 *
 * ## 为什么必须合成一个 batch（P1-1）
 *
 * 旧实现是「`UPDATE orders` 提交 → 再 `batch(sub_orders + log)` → 再单独
 * `releaseSkuStocks`」三次提交。中间任一瞬时报错就会留下**订单已 CANCELLED
 * 但锁定库存没释放**的永久泄漏：重试会在 `status !== 'PENDING_PAYMENT'` 处
 * 提前 return，任务随即被置 `done`，锁定再也不会被释放。
 *
 * ## 为什么后续语句要带 `EXISTS` 守卫
 *
 * batch 内第 1 条语句才是关单判据；后续语句若不带条件，订单**已支付**时
 * 仍会释放库存（把别人的钱货对应关系弄坏）。故后续每条都加：
 * `AND EXISTS (SELECT 1 FROM orders o WHERE o.id = ? AND o.status = 'CANCELLED' AND o.cancelled_at = ?)`
 * ——batch 内语句按序执行，第 1 条已生效，`EXISTS` 读到的是**本事务内的最新状态**。
 *
 * @returns `true` 表示**本次调用真的完成了状态迁移**（第 1 条语句 `meta.changes === 1`）；
 *          `false` 表示该单已被支付 / 已被取消 / 被并发调用抢先处理——此时**整批
 *          后续语句都因 `EXISTS` 不成立而空转**，锁定库存不会被误释放（幂等，
 *          `docs/08:105`、`docs/08:111`）。
 *
 * ⚠️ `releaseSkuStatement` 自带的 `WHERE locked_stock >= ?` 守卫**必须保留**：
 * 重复释放（人工重放）时它保证锁定不会被扣成负数。
 */
export async function cancelUnpaidOrder(
  db: D1Database,
  input: {
    readonly orderId: string;
    readonly nowIso: string;
    /** 该主单下每条 `order_items` 的 SKU 与数量（释放锁定的依据）。 */
    readonly skuQuantities: readonly { readonly skuId: string; readonly quantity: number }[];
  },
): Promise<boolean> {
  const { orderId, nowIso } = input;
  // 「本事务内确实完成了关单」的守卫条件（见函数注释的 EXISTS 说明）。
  const cancelledGuard =
    "EXISTS (SELECT 1 FROM orders o WHERE o.id = ? AND o.status = 'CANCELLED' AND o.cancelled_at = ?)";

  const statements: D1PreparedStatement[] = [
    // ① 关单判据（唯一）：`changes === 1` 才代表本次真的完成迁移。
    db
      .prepare(
        `UPDATE orders
            SET status = 'CANCELLED', cancelled_at = ?, updated_at = ?
          WHERE id = ? AND status = 'PENDING_PAYMENT'`,
      )
      .bind(nowIso, nowIso, orderId),
    // ② 同步子单（主单状态由子单聚合，`docs/08` §8.3）
    db
      .prepare(
        `UPDATE sub_orders
            SET status = 'CANCELLED', updated_at = ?
          WHERE order_id = ? AND status = 'PAID' AND ${cancelledGuard}`,
      )
      .bind(nowIso, orderId, orderId, nowIso),
    // ③ 状态日志：用 `INSERT ... SELECT ... WHERE EXISTS` 才能带上守卫。
    // `OR IGNORE` 是幂等兜底：同一毫秒的并发重放会让 `-TC` 主键撞车，
    // 若直接报错会**整批回滚**（连关单一起回滚）→ 无谓重试；这里静默跳过。
    db
      .prepare(
        `INSERT OR IGNORE INTO order_status_logs
           (id, order_id, sub_order_id, kind, from_status, to_status, actor_type,
            actor_id, remark, occurred_at, created_at)
         SELECT ?, ?, NULL, 'status', 'PENDING_PAYMENT', 'CANCELLED', 'system',
                NULL, NULL, ?, ?
          WHERE ${cancelledGuard}`,
      )
      .bind(`${orderId}-TC`, orderId, nowIso, nowIso, orderId, nowIso),
  ];

  // ④ 释放锁定：与关单同批提交，杜绝「关了单但没释放」的永久泄漏
  for (const item of input.skuQuantities) {
    statements.push(
      db
        .prepare(
          `UPDATE product_skus
              SET locked_stock = locked_stock - ?
            WHERE id = ? AND locked_stock >= ? AND ${cancelledGuard}`,
        )
        .bind(item.quantity, item.skuId, item.quantity, orderId, nowIso),
    );
  }

  const results = await db.batch(statements);
  return (results[0]?.meta?.changes ?? 0) === 1;
}

/** 该主单下每条 `order_items` 的 SKU 与数量（超时关单释放锁定的依据）。 */
export async function listOrderSkuQuantities(
  db: D1Database,
  orderId: string,
): Promise<{ readonly sku_id: string; readonly quantity: number }[]> {
  const res = await db
    .prepare("SELECT sku_id, quantity FROM order_items WHERE order_id = ?")
    .bind(orderId)
    .all<{ readonly sku_id: string; readonly quantity: number }>();
  return res.results;
}

/* -------------------------------------------------------------------------- */
/* 下单写库                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 原子写入主单 + 子单 + 明细 + 状态日志（`DB.batch()`，`docs/05` §5.3②）。
 *
 * ⚠️ 调用前**必须**已成功锁定全部 SKU。
 */
export async function insertShopOrder(db: D1Database, input: ShopOrderWriteInput): Promise<void> {
  const statements: D1PreparedStatement[] = [];

  statements.push(
    db
      .prepare(
        `INSERT INTO orders
           (id, order_no, user_id, status, total_amount, discount_amount, freight_amount,
            pay_amount, address_snapshot, coupon_id, channel, pay_deadline, paid_at,
            completed_at, cancelled_at, remark, created_at, updated_at)
         VALUES (?, ?, ?, 'PENDING_PAYMENT', ?, ?, ?, ?, ?, NULL, ?, ?, NULL,
                 NULL, NULL, ?, ?, ?)`,
      )
      .bind(
        input.orderId,
        input.orderNo,
        input.userId,
        input.totalAmount,
        input.discountAmount,
        input.freightAmount,
        input.payAmount,
        input.addressSnapshot,
        input.channel,
        input.payDeadline,
        input.remark,
        input.nowIso,
        input.nowIso,
      ),
  );

  statements.push(
    db
      .prepare(
        `INSERT INTO order_status_logs
           (id, order_id, sub_order_id, kind, from_status, to_status, actor_type,
            actor_id, remark, occurred_at, created_at)
         VALUES (?, ?, NULL, 'status', NULL, 'PENDING_PAYMENT', 'user', ?, NULL, ?, ?)`,
      )
      .bind(`${input.orderId}-L0`, input.orderId, input.userId, input.nowIso, input.nowIso),
  );

  for (const sub of input.subOrders) {
    statements.push(
      db
        .prepare(
          `INSERT INTO sub_orders
             (id, sub_order_no, order_id, merchant_id, store_id, status, subtotal,
              discount_alloc, freight, commission_amount, express_company,
              express_company_code, express_no, shipped_at, received_at, settled,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'PAID', ?, ?, ?, 0, NULL, NULL, NULL, NULL, NULL, 0, ?, ?)`,
        )
        .bind(
          sub.id,
          sub.subOrderNo,
          input.orderId,
          sub.merchantId,
          sub.storeId,
          sub.subtotal,
          sub.discountAlloc,
          sub.freight,
          input.nowIso,
          input.nowIso,
        ),
    );

    for (const item of sub.items) {
      statements.push(
        db
          .prepare(
            `INSERT INTO order_items
               (id, sub_order_id, order_id, spu_id, sku_id, title, image, spec,
                unit_price, quantity, subtotal, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            item.id,
            sub.id,
            input.orderId,
            item.spuId,
            item.skuId,
            item.title,
            item.image,
            item.spec,
            item.unitPrice,
            item.quantity,
            item.subtotal,
            input.nowIso,
          ),
      );
    }
  }

  await db.batch(statements);
}

/* -------------------------------------------------------------------------- */
/* 取数                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 分页列出该用户的订单（后台组统一分页 `{ page, pageSize, total, list }`）。
 *
 * ⚠️ 主单 `orders.status` 是**聚合结果的物化值**（`docs/08` §8.3）。
 * 列表的 `status` 过滤走 `orders.status`，与详情页由子单实时聚合的口径一致
 * （下单 / 支付 / 取消时都会同步写 `orders.status`）。
 */
export async function listShopOrders(
  db: D1Database,
  input: {
    readonly userId: string;
    readonly status?: OrderStatus | undefined;
    readonly page: number;
    readonly pageSize: number;
  },
): Promise<ShopOrderListResult> {
  const conditions: string[] = ["user_id = ?"];
  const args: unknown[] = [input.userId];
  if (input.status !== undefined) {
    conditions.push("status = ?");
    args.push(input.status);
  }
  const where = conditions.join(" AND ");
  const offset = (input.page - 1) * input.pageSize;

  const [rowRes, countRes] = await Promise.all([
    db
      .prepare(
        `SELECT ${ORDER_COLUMNS} FROM orders
          WHERE ${where}
          ORDER BY created_at DESC, order_no DESC
          LIMIT ? OFFSET ?`,
      )
      .bind(...args, input.pageSize, offset)
      .all<ShopOrderRow>(),
    db
      .prepare(`SELECT COUNT(*) AS total FROM orders WHERE ${where}`)
      .bind(...args)
      .first<{ total: number }>(),
  ]);

  const orders = rowRes.results;
  if (orders.length === 0) return { rows: [], total: countRes?.total ?? 0 };

  const orderIds = orders.map((o) => o.id);
  const ph = placeholders(orderIds.length);

  const [subRes, itemRes, aftersaleRes] = await Promise.all([
    db
      .prepare(`SELECT order_id, status FROM sub_orders WHERE order_id IN (${ph})`)
      .bind(...orderIds)
      .all<{ order_id: string; status: SubOrderStatus }>(),
    db
      .prepare(
        `SELECT ${ORDER_ITEM_COLUMNS} FROM order_items
          WHERE order_id IN (${ph})
          ORDER BY created_at ASC, id ASC`,
      )
      .bind(...orderIds)
      .all<ShopOrderItemRow & { order_id: string }>(),
    db
      .prepare(`SELECT order_id, status, refund_amount FROM aftersales WHERE order_id IN (${ph})`)
      .bind(...orderIds)
      .all<{ order_id: string; status: string; refund_amount: number }>(),
  ]);

  const statusesByOrder = new Map<string, SubOrderStatus[]>();
  for (const row of subRes.results) {
    const list = statusesByOrder.get(row.order_id);
    if (list === undefined) statusesByOrder.set(row.order_id, [row.status]);
    else list.push(row.status);
  }

  const itemsByOrder = new Map<string, ShopOrderItemRow[]>();
  for (const row of itemRes.results) {
    const list = itemsByOrder.get(row.order_id);
    if (list === undefined) itemsByOrder.set(row.order_id, [row]);
    else list.push(row);
  }

  const aftersalesByOrder = new Map<string, { status: string; refund_amount: number }[]>();
  for (const row of aftersaleRes.results) {
    const list = aftersalesByOrder.get(row.order_id);
    if (list === undefined) aftersalesByOrder.set(row.order_id, [row]);
    else list.push(row);
  }

  return {
    rows: orders.map((order) => ({
      order,
      subOrderStatuses: statusesByOrder.get(order.id) ?? [],
      items: itemsByOrder.get(order.id) ?? [],
      aftersales: aftersalesByOrder.get(order.id) ?? [],
    })),
    total: countRes?.total ?? 0,
  };
}

/**
 * 按主单号取订单详情聚合体（带**归属校验**：`user_id` 不匹配即视为不存在）。
 *
 * 归属在 SQL 里强制（`WHERE order_no = ? AND user_id = ?`），
 * 返回 `null` 时路由回 `ERR_SHOP_ORDER_NOT_FOUND`——**不区分**「不存在」与「不属于你」，防枚举。
 */
export async function findShopOrderByNo(
  db: D1Database,
  userId: string,
  orderNo: string,
): Promise<ShopOrderDetailAggregate | null> {
  const order = await db
    .prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE order_no = ? AND user_id = ? LIMIT 1`)
    .bind(orderNo, userId)
    .first<ShopOrderRow>();
  if (order === null) return null;

  const [subRes, itemRes, aftersaleRes] = await Promise.all([
    db
      .prepare(
        `SELECT ${SUB_ORDER_COLUMNS} ${SUB_ORDER_FROM}
          WHERE s.order_id = ?
          ORDER BY s.sub_order_no ASC`,
      )
      .bind(order.id)
      .all<ShopSubOrderRow>(),
    db
      .prepare(
        `SELECT ${ORDER_ITEM_COLUMNS} FROM order_items
          WHERE order_id = ?
          ORDER BY created_at ASC, id ASC`,
      )
      .bind(order.id)
      .all<ShopOrderItemRow>(),
    db
      .prepare("SELECT status, refund_amount FROM aftersales WHERE order_id = ?")
      .bind(order.id)
      .all<{ status: string; refund_amount: number }>(),
  ]);

  return {
    order,
    subOrders: subRes.results,
    items: itemRes.results,
    aftersales: aftersaleRes.results,
  };
}

/**
 * 取该商户的默认履约门店 id（`sub_orders.store_id` 的取值来源）。
 *
 * 一期按 `docs/05` §5.4「形态 A：总部统管」运营：商品挂在总部商户下，
 * 门店只做履约。就近分配属后台能力（`docs/08` §8.5），此处取该商户首个启用门店。
 * 查不到返回 `null`（路由回 500 级错误——缺履约节点是**数据配置问题**，不是用户输入问题）。
 */
export async function findMerchantDefaultStoreId(
  db: D1Database,
  merchantId: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT id FROM stores
        WHERE merchant_id = ? AND status = 'active'
        ORDER BY type ASC, name ASC
        LIMIT 1`,
    )
    .bind(merchantId)
    .first<{ id: string }>();
  return row?.id ?? null;
}

/* -------------------------------------------------------------------------- */
/* 支付（占位）                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * 落一条 `payments` 占位流水并返回支付单号。
 *
 * ⚠️ **未接任何支付渠道**：`channel_trade_no` 是占位串（真实值由渠道回调回填），
 * `status` 为 `PENDING`。`docs/08` §8.2 的「发起支付 → 渠道 → 回调 → 锁定转实扣」
 * 链路由 callbacks 组与后续里程碑实现。
 */
export async function insertPaymentPlaceholder(
  db: D1Database,
  input: {
    readonly id: string;
    readonly payNo: string;
    readonly orderId: string;
    readonly channel: PaymentChannel;
    readonly amount: number;
    readonly nowIso: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO payments
         (id, pay_no, order_id, channel, channel_trade_no, amount, status, paid_at,
          raw_callback, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'PENDING', NULL, NULL, ?, ?)`,
    )
    .bind(
      input.id,
      input.payNo,
      input.orderId,
      input.channel,
      `PENDING-${input.payNo}`,
      input.amount,
      input.nowIso,
      input.nowIso,
    )
    .run();
}

/** 查询该用户某主单的可支付性（返回状态与金额，供 pay 端点做前置校验）。 */
export async function findShopOrderForPay(
  db: D1Database,
  userId: string,
  orderNo: string,
): Promise<{
  readonly id: string;
  readonly status: OrderStatus;
  readonly pay_amount: number;
} | null> {
  return await db
    .prepare("SELECT id, status, pay_amount FROM orders WHERE order_no = ? AND user_id = ? LIMIT 1")
    .bind(orderNo, userId)
    .first<{ id: string; status: OrderStatus; pay_amount: number }>();
}

/** 支付单序号（`formatPayNo` 的 `seq`）。 */
export async function nextPaySeq(db: D1Database, prefix: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS total FROM payments WHERE pay_no LIKE ?")
    .bind(`${prefix}%`)
    .first<{ total: number }>();
  return (row?.total ?? 0) + 1;
}
