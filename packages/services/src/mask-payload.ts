/**
 * Agent 响应载荷**单一出口**脱敏器（`docs/07` §7.8.2「实现约束」，M0 ★ 必交付项）。
 *
 * > Agent 组**所有响应必须经过 `maskAgentPayload()` 单一出口函数**；该函数以 Zod Schema
 * > 的 `.strip()` 模式运行——**白名单外字段一律丢弃**，而非黑名单式删除。
 * > 这是防止「新增字段意外泄露」的结构性保证（P3）。
 *
 * ## 「白名单 + 黑名单」双保险的分工
 *
 * | 层 | 机制 | 挡什么 |
 * | --- | --- | --- |
 * | ① 白名单（结构性，主闸门） | 用契约 Schema（`z.object` 默认 `.strip()`）解析，**白名单外字段一律丢弃** | 将来 mapper / SQL 多带任何字段（如新加的「用户备注」「内部标签」），默认**不下发** |
 * | ② 黑名单（纵深防御，副闸门） | 裁剪之后再跑 `stripForbiddenFields()` | Schema 自身漏写的情况——例如 `z.record()`（`SkuSpec`）**不裁剪键**，有人误把敏感键塞进这类「开放形状」；或有人把 `cost_price` 写进了 Schema 定义 |
 *
 * 分工理由：白名单是「安全默认值 = 不发」，覆盖新增字段的**未知**风险；
 * 黑名单只覆盖**已知**的绝对红线字段名。两者叠加，任一层单独失效都不会导致泄漏。
 *
 * ## 失败处理（宁可 500，也不漏字段）
 *
 * `safeParse` 失败时**绝不返回原始 payload**（那等于绕过脱敏）。本函数抛
 * `AgentPayloadMaskError`（含 zod issues，便于诊断），由上层 `app.onError`
 * 统一转成 `500` + `50001`。**校验失败 = 契约与实现不一致的 bug**，必须显式暴露。
 *
 * 日志只打 `endpoint` 与 issue 的 `path`/`code`，**不打完整 payload**（可能含 PII）。
 */

import type { ZodIssue, ZodType } from "zod";

import { stripForbiddenFields } from "./mask.js";

/**
 * 载荷未通过契约 Schema 校验时抛出的类型化错误。
 *
 * 携带 zod `issues` 便于定位（路由/中间件日志只打 path，不打 payload）。
 */
export class AgentPayloadMaskError extends Error {
  /** 出错端点标识（如 `GET /orders/{orderNo}`），仅用于日志定位。 */
  readonly endpoint: string;
  /** zod 校验问题列表（原始 issues，含 path / code / message）。 */
  readonly issues: readonly ZodIssue[];

  constructor(endpoint: string, issues: readonly ZodIssue[]) {
    super(
      `Agent 响应载荷未通过契约 Schema 校验（endpoint=${endpoint}）：${issues
        .map((issue) => `${formatIssuePath(issue)}: ${issue.message}`)
        .join("; ")}`,
    );
    this.name = "AgentPayloadMaskError";
    this.endpoint = endpoint;
    this.issues = issues;
  }
}

/** issue 路径 → `a.b.0.c`（空路径用 `<root>`，符号键安全字符串化）。 */
function formatIssuePath(issue: ZodIssue): string {
  const path = issue.path.map((segment) => String(segment)).join(".");
  return path.length > 0 ? path : "<root>";
}

/**
 * Agent 响应的**唯一出口**：白名单裁剪（Schema `.strip()`）+ 黑名单二次剔除。
 *
 * @param schema  该端点 `data` 的契约 Schema（`@dshop/shared` 的 `Agent*Schema`）
 * @param payload mapper 产出的载荷（可能被污染，多带未知/敏感字段）
 * @param endpoint 端点标识，**仅用于失败日志**（不参与脱敏逻辑）
 * @returns 裁剪后的载荷（类型即 Schema 的输出类型）
 * @throws AgentPayloadMaskError 载荷不满足 Schema 时（由上层转 `50001`）
 */
export function maskAgentPayload<T>(
  schema: ZodType<T>,
  payload: unknown,
  endpoint = "unknown",
): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    // 只打端点与 issue 路径：payload 可能含 PII，绝不落日志。
    console.error(
      JSON.stringify({
        level: "error",
        event: "agent_payload_mask_failed",
        endpoint,
        issues: parsed.error.issues.map((issue) => ({
          path: formatIssuePath(issue),
          code: issue.code,
          message: issue.message,
        })),
      }),
    );
    throw new AgentPayloadMaskError(endpoint, parsed.error.issues);
  }

  // 纵深防御：Schema 裁剪后再过黑名单，确保「误写进 Schema 的敏感字段」也被剔除。
  return stripForbiddenFields(parsed.data);
}
