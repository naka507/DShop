/**
 * 状态文案表（Agent 契约 `statusText` 字段的唯一取值来源）。
 *
 * 权威来源优先级：
 * 1. `@dshop/shared` 的 `enums.ts` —— 已按 `docs/07` 逐字定义
 *    `ORDER_STATUS_TEXT` / `SUB_ORDER_STATUS_TEXT` / `AFTERSALE_STATUS_TEXT` /
 *    `AFTERSALE_TYPE_TEXT`，本文件**只做再导出**，不重复实现。
 * 2. `PRODUCT_STATUS_TEXT` —— **⚠️ 文档未定义**：`docs/07` §7.4 的 `status`
 *    是枚举而非文案（`AgentProductSpecsSchema` 无 `statusText` 字段），
 *    05 §5.2 也未给出中文文案。实现侧按同构风格补齐并登记到 README「文档未定义项」。
 */

import { PRODUCT_STATUS } from "@dshop/shared";
import type { ProductStatus } from "@dshop/shared";

export {
  AFTERSALE_STATUS_TEXT,
  AFTERSALE_TYPE_TEXT,
  ORDER_STATUS_TEXT,
  SUB_ORDER_STATUS_TEXT,
} from "@dshop/shared";

/** ⚠️ **文档未定义**：商品状态中文文案（`/products/*` 目前不下发 `statusText`，仅备将来使用）。 */
export const PRODUCT_STATUS_TEXT: Record<ProductStatus, string> = {
  [PRODUCT_STATUS.DRAFT]: "草稿",
  [PRODUCT_STATUS.PENDING_REVIEW]: "待审核",
  [PRODUCT_STATUS.ONSALE]: "在售",
  [PRODUCT_STATUS.OFFSALE]: "已下架",
  [PRODUCT_STATUS.REJECTED]: "已驳回",
};
