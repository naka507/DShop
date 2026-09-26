/**
 * Agent 组类型化调用（`docs/07` §7.2–§7.7）。
 *
 * **鉴权是 `X-Service-Token`**（`docs/07` §7.8.1），由 `TypedApiClient("agent")` 自动注入。
 * 六个端点**全部只读 GET**（`docs/07` §7.8.3），故本模块不导出任何写方法。
 *
 * 响应 `data` 一律用 `@dshop/shared` 的 `Agent*Schema` 校验——
 * 契约即类型，服务端漂移会在客户端边界立即暴露。
 */

import {
  AgentAftersaleDetailSchema,
  AgentOrderDetailSchema,
  AgentOrderListSchema,
  AgentPoliciesSchema,
  AgentProductSpecsSchema,
  AgentProductStockSchema,
} from "@dshop/shared";

import type { TypedApiClient } from "./client.js";
import type { RequestOptions } from "./client.js";
import type { Unpacked } from "./envelope.js";
import type {
  AgentAftersaleDetail,
  AgentOrderDetail,
  AgentOrderList,
  AgentPolicies,
  AgentProductSpecs,
  AgentProductStock,
} from "@dshop/shared";

/** `GET /orders` 查询参数（`docs/07` §7.3）。 */
export interface AgentOrdersQuery {
  /** 与 `phone` 二选一。 */
  readonly userId?: string;
  /** 与 `userId` 二选一；**不进访问日志**（`docs/07:134`）。 */
  readonly phone?: string;
  /** 主单状态过滤，多值逗号分隔。 */
  readonly status?: string;
  /** 1–20，默认 5。 */
  readonly limit?: number;
  /** 游标，取自上次响应的 `nextCursor`。 */
  readonly cursor?: string;
}

/** `GET /products/{spuId}/stock` 查询参数（`docs/07` §7.5）。 */
export interface AgentStockQuery {
  readonly skuId?: string;
  readonly quantity?: number;
  readonly regionCode?: string;
}

/** Agent 组类型化调用集合。 */
export class AgentApi {
  private readonly client: TypedApiClient<"agent">;

  constructor(client: TypedApiClient<"agent">) {
    this.client = client;
  }

  /** `GET /orders/{orderNo}` —— 订单主单 + 子单 + 物流（`docs/07` §7.2）。 */
  getOrder(orderNo: string, options?: RequestOptions): Promise<Unpacked<AgentOrderDetail>> {
    return this.client.get(
      `/orders/${encodeURIComponent(orderNo)}`,
      AgentOrderDetailSchema,
      options,
    );
  }

  /** `GET /orders` —— 用户最近订单列表（`docs/07` §7.3）。 */
  listOrders(query: AgentOrdersQuery, options?: RequestOptions): Promise<Unpacked<AgentOrderList>> {
    return this.client.get("/orders", AgentOrderListSchema, {
      ...options,
      query: { ...query, ...options?.query },
    });
  }

  /**
   * `GET /products/{spuId}/specs` —— 商品规格 / 参数白皮书（`docs/07` §7.4）。
   *
   * 传 `ifNoneMatch`（上次的 `data.contentHash`）时，未变更返回 `304`
   * （`docs/07:150`）；此时结果是 `ApiNotModified`（`data: null`）。
   */
  getProductSpecs(spuId: string, options?: RequestOptions): Promise<Unpacked<AgentProductSpecs>> {
    return this.client.get(
      `/products/${encodeURIComponent(spuId)}/specs`,
      AgentProductSpecsSchema,
      options,
    );
  }

  /** `GET /products/{spuId}/stock` —— 库存与发货地（`docs/07` §7.5）。 */
  getProductStock(
    spuId: string,
    query?: AgentStockQuery,
    options?: RequestOptions,
  ): Promise<Unpacked<AgentProductStock>> {
    return this.client.get(
      "/products/" + encodeURIComponent(spuId) + "/stock",
      AgentProductStockSchema,
      {
        ...options,
        query: { ...query, ...options?.query },
      },
    );
  }

  /** `GET /aftersales/{aftersaleNo}` —— 售后单状态与时间线（`docs/07` §7.6）。 */
  getAftersale(
    aftersaleNo: string,
    options?: RequestOptions,
  ): Promise<Unpacked<AgentAftersaleDetail>> {
    return this.client.get(
      `/aftersales/${encodeURIComponent(aftersaleNo)}`,
      AgentAftersaleDetailSchema,
      options,
    );
  }

  /**
   * `GET /policies/{category}` —— 售后政策条款（`docs/07` §7.7）。
   *
   * 支持 `ifNoneMatch` → `304`（`docs/07:296`）。
   */
  getPolicies(category: string, options?: RequestOptions): Promise<Unpacked<AgentPolicies>> {
    return this.client.get(
      `/policies/${encodeURIComponent(category)}`,
      AgentPoliciesSchema,
      options,
    );
  }
}
