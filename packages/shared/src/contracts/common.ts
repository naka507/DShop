/**
 * 通用契约原语（契约中心，零业务逻辑）。
 *
 * 权威来源：`docs/07-Agent-API契约.md` §7.1–§7.2。
 */

import { z } from "zod";
import { CURRENCY, CurrencySchema } from "../enums.js";
import { UlidSchema } from "../ids.js";

export { CURRENCY, CurrencySchema };

/** 金额：整数，单位**分**（05 §5.3 金额口径）。 */
export const MoneySchema = z
  .number()
  .int("金额必须为整数（单位：分）")
  .nonnegative("金额不能为负");

/** 时间：ISO-8601 字符串，**UTC**（05 §5.3 时间口径）。 */
export const IsoDateTimeSchema = z.iso.datetime({ offset: false });

/** 日期（`YYYY-MM-DD`），用于 `restockEta`。 */
export const IsoDateSchema = z.iso.date();

/**
 * 脱敏手机号：保留前 3 后 4（07 §7.8.2）。
 *
 * 例：`138****8888`。固定电话保留区号：`0571****0000`。
 */
export const MaskedPhoneSchema = z
  .string()
  .regex(/^\d{3,4}\*{4}\d{0,4}$/, "须为脱敏手机号（如 138****8888）");

/** 脱敏姓名：姓氏 + `**`（07 §7.8.2）。例：`张**`。 */
export const MaskedNameSchema = z.string().regex(/^.\*{1,2}$/, "须为脱敏姓名（如 张**）");

/** 省/市/区（脱敏地址的可见部分）。例：`浙江省 杭州市 西湖区`。 */
export const RegionSchema = z.string().min(1);

/** 脱敏地址：省市区 + `***`（07 §7.8.2）。例：`浙江省 杭州市 西湖区 ***`。 */
export const MaskedAddressSchema = z
  .string()
  .regex(/\*{3}$/, "须为脱敏地址（省市区 + ***）");

/** 收件人（已脱敏）。07 §7.2 `receiver`。 */
export const ReceiverSchema = z.object({
  name: MaskedNameSchema,
  phone: MaskedPhoneSchema,
  region: RegionSchema,
  addressMasked: MaskedAddressSchema,
});
export type Receiver = z.infer<typeof ReceiverSchema>;

/** 退货地址（已脱敏）。07 §7.5 `returnAddress`。 */
export const ReturnAddressSchema = ReceiverSchema;
export type ReturnAddress = z.infer<typeof ReturnAddressSchema>;

/** 发货地（来自 `sub_orders.store_id` → `stores`）。07 §7.2 `shipFrom`。 */
export const ShipFromSchema = z.object({
  storeName: z.string().min(1),
  city: z.string().min(1),
});
export type ShipFrom = z.infer<typeof ShipFromSchema>;

/** `/stock` 的发货地（比 `ShipFrom` 多 storeId/type/province/supportsPickup）。07 §7.5。 */
export const StockShipFromSchema = z.object({
  storeId: UlidSchema,
  storeName: z.string().min(1),
  type: z.string().min(1),
  city: z.string().min(1),
  province: z.string().min(1),
  supportsPickup: z.boolean(),
});
export type StockShipFrom = z.infer<typeof StockShipFromSchema>;

/** 物流轨迹节点。07 §7.2 `express.traces[]`。 */
export const ExpressTraceSchema = z.object({
  time: IsoDateTimeSchema,
  desc: z.string().min(1),
});
export type ExpressTrace = z.infer<typeof ExpressTraceSchema>;

/** 物流信息。07 §7.2 `express`。`traces` 最多返回最近 **10** 条。 */
export const ExpressSchema = z.object({
  company: z.string().min(1),
  companyCode: z.string().min(1),
  no: z.string().min(1),
  shippedAt: IsoDateTimeSchema.nullable(),
  latestStatus: z.string().min(1),
  latestStatusAt: IsoDateTimeSchema.nullable(),
  traces: z.array(ExpressTraceSchema).max(10, "traces 最多返回最近 10 条"),
});
export type Express = z.infer<typeof ExpressSchema>;

/** SKU 规格维度值（`{"颜色":"曜石黑","版本":"降噪版"}`）。 */
export const SkuSpecSchema = z.record(z.string(), z.string());
export type SkuSpec = z.infer<typeof SkuSpecSchema>;

/** 订单商品快照。07 §7.2 `subOrders[].items[]`。 */
export const OrderItemSchema = z.object({
  skuId: UlidSchema,
  title: z.string().min(1),
  spec: SkuSpecSchema,
  unitPrice: MoneySchema,
  quantity: z.number().int().positive(),
  subtotal: MoneySchema,
});
export type OrderItem = z.infer<typeof OrderItemSchema>;

/** 分页游标（base64 编码的不透明串）。07 §7.3 `nextCursor`。 */
export const CursorSchema = z.string().min(1);

/**
 * 契约版本（07 §7.9）。
 *
 * 载体是请求头 `X-Contract-Version`；**缺失视为 `1` 并记告警**，不返回错误。
 * 显式提供不受支持的版本 → `400` + `code 40010`。
 */
export const CONTRACT_VERSION_HEADER = "X-Contract-Version";
export const CONTRACT_VERSION_CURRENT = "1";
export const SUPPORTED_CONTRACT_VERSIONS: readonly string[] = ["1"];

/** 服务令牌请求头（07 §7.8.1：**非** Bearer，不允许放 query string）。 */
export const SERVICE_TOKEN_HEADER = "X-Service-Token";
