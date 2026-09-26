/**
 * 统一响应体解包与错误码分流（四组共用）。
 *
 * ## 契约
 *
 * `docs/06-API路由命名空间.md:18`：**统一响应体（五组路由共用）** `{ code, message, data }`。
 *
 * ## 两套错误码（**绝不混用**）
 *
 * `docs/README.md:34` / `docs/06:20`：
 * - `/api/v1/agent/*` 用**整数**码（`0` / `40001` / `40101` …，`docs/07` §7.1）；
 * - shop / admin / merchant 用**字符串**码（`ERR_<域>_<原因>`，`@dshop/shared` 的
 *   `BACKOFFICE_ERROR_CODES`）。
 *
 * 两者值域不重叠（整数 vs `ERR_` 前缀），故可用 `typeof code` 判定归属——
 * 本文件的失败类型据此分成 `AgentFailure` / `BackofficeFailure` 两个形态，
 * 调用方在 `switch (result.kind)` 下即可拿到**精确的 code 类型**。
 *
 * ## 304
 *
 * `docs/07:150` / `docs/07:296`：Agent 的 `/specs` 与 `/policies` 支持
 * `contentHash` + `ifNoneMatch` 条件请求，未变更返回 **`304` 且空 body**。
 * 空 body 无法解析 JSON，故单列为 `ApiNotModified`，不混进成功/失败两态。
 */

import { AGENT_ERROR_CODES, AgentErrorCodeSchema, isAgentPath } from "@dshop/shared";
import type { AgentErrorCode } from "@dshop/shared";
import { z } from "zod";

/* -------------------------------------------------------------------------- */
/* 信封                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * 统一响应体。`code` 放宽为 `number | string`，具体归属由 `path` 决定
 * （`isAgentPath()`）；`data` 交给调用方的 Zod schema 校验。
 */
export const ApiEnvelopeSchema = z.object({
  code: z.union([z.number(), z.string()]),
  message: z.string(),
  data: z.unknown(),
});
export type ApiEnvelope = z.infer<typeof ApiEnvelopeSchema>;

/** 成功码：Agent 组固定为整数 `0`（`docs/07` §7.1）。 */
export const AGENT_OK_CODE = AGENT_ERROR_CODES.OK;

/* -------------------------------------------------------------------------- */
/* 解包结果类型                                                                  */
/* -------------------------------------------------------------------------- */

/** 响应元信息（成败共有）。 */
interface ResultMeta {
  /** HTTP 状态码。 */
  readonly status: number;
  /** 信封的 `message`。 */
  readonly message: string;
  /** 响应头（含 `X-Cache` / `X-RateLimit-*` / `ETag` 等）。 */
  readonly headers: Headers;
}

/** 成功（`code === 0` 且 `data` 通过 Zod 校验）。 */
export interface ApiSuccess<T> extends ResultMeta {
  readonly ok: true;
  readonly notModified: false;
  readonly code: typeof AGENT_OK_CODE;
  readonly data: T;
}

/**
 * `304 Not Modified`（`docs/07:150`）。
 *
 * 语义是「你手上的 `contentHash` 仍是最新」，**不是失败**，故 `ok: true`；
 * 但 `data` 为空，且与 `ApiSuccess<T>` 的 `data: T` 不同型，故用
 * `notModified: true` 判别。
 */
export interface ApiNotModified extends ResultMeta {
  readonly ok: true;
  readonly notModified: true;
  readonly status: 304;
  readonly code: typeof AGENT_OK_CODE;
  readonly data: null;
}

/** Agent 组失败：**整数**错误码（`docs/07` §7.1）。 */
export interface AgentFailure extends ResultMeta {
  readonly ok: false;
  readonly kind: "agent";
  readonly code: AgentErrorCode;
  /** 原始 code（未知码时与 `code` 不同，便于告警时保真上报）。 */
  readonly rawCode: number;
  /** `429` 时来自 `Retry-After`（`docs/07` §7.1）。 */
  readonly retryAfterSeconds: number | null;
}

/** 后台三组失败：**字符串**错误码（`docs/README.md:34`）。 */
export interface BackofficeFailure extends ResultMeta {
  readonly ok: false;
  readonly kind: "backoffice";
  /** 形如 `ERR_ADMIN_NOT_FOUND`；未知码也原样保留（不做映射丢失）。 */
  readonly code: string;
}

/** 解包结果。 */
export type Unpacked<T> = ApiSuccess<T> | ApiNotModified | AgentFailure | BackofficeFailure;

/* -------------------------------------------------------------------------- */
/* 解包                                                                         */
/* -------------------------------------------------------------------------- */

/** 解包失败的原因（用于日志与告警，不对外暴露）。 */
export type DecodeFailureReason = "non_json_body" | "malformed_envelope" | "data_schema_mismatch";

/**
 * 解包选项。
 *
 * @param path 请求路径（决定错误码归属：`isAgentPath()`）
 * @param dataSchema 响应 `data` 的 Zod schema（**契约即类型**）
 * @param body 已读出的响应体文本（`304` 时为空串）
 */
export interface DecodeOptions<T> {
  readonly path: string;
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
  readonly dataSchema: z.ZodType<T>;
}

/** 读取 `Retry-After`（秒）。 */
function parseRetryAfter(headers: Headers): number | null {
  const raw = headers.get("Retry-After");
  if (raw === null) return null;
  const seconds = Number.parseInt(raw, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/**
 * 构造失败结果。
 *
 * `path` 决定形态：Agent 路径 → `AgentFailure`（整数码）；
 * 其余 → `BackofficeFailure`（字符串码）。
 */
function failureFor(
  path: string,
  status: number,
  message: string,
  headers: Headers,
  rawCode: number | string,
): AgentFailure | BackofficeFailure {
  if (isAgentPath(path)) {
    const numeric = typeof rawCode === "number" ? rawCode : Number.parseInt(rawCode, 10);
    const safe = Number.isFinite(numeric) ? numeric : AGENT_ERROR_CODES.INTERNAL_ERROR;
    const parsed = AgentErrorCodeSchema.safeParse(safe);
    return {
      ok: false,
      kind: "agent",
      code: parsed.success ? parsed.data : AGENT_ERROR_CODES.INTERNAL_ERROR,
      rawCode: safe,
      retryAfterSeconds: parseRetryAfter(headers),
      status,
      message,
      headers,
    };
  }

  const text = typeof rawCode === "string" ? rawCode : String(rawCode);
  return {
    ok: false,
    kind: "backoffice",
    // 未知码**原样保留**（不映射成固定码）：映射会丢失服务端信息，反而妨碍排障。
    code: text,
    status,
    message,
    headers,
  };
}

/**
 * 解包统一响应体。
 *
 * 判定顺序（**顺序即语义**）：
 * 1. `304` → `ApiNotModified`（空 body，不进 JSON 解析）
 * 2. 体非 JSON → 失败（形态按 `path` 分流，message 取原文截断）
 * 3. 信封结构不符 → 失败
 * 4. `code !== 0` → 失败
 * 5. `code === 0` 且 `data` 通过 schema → 成功；否则失败（`data_schema_mismatch`）
 *
 * 第 5 步的 schema 校验是**契约即类型**的落点：服务端一旦漂移，
 * 客户端在边界处立刻失败，而不是把脏数据一路带进业务层。
 */
export function decodeEnvelope<T>(options: DecodeOptions<T>): Unpacked<T> {
  const { path, status, headers, body, dataSchema } = options;

  // 1. 304：空 body，无信封可解（docs/07:150）
  if (status === 304) {
    return {
      ok: true,
      notModified: true,
      status: 304,
      code: AGENT_OK_CODE,
      message: "not modified",
      data: null,
      headers,
    };
  }

  // 2. 非 JSON 体（如网关返回的 HTML 错误页）
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(body);
  } catch {
    const snippet = body.trim().slice(0, 200);
    return failureFor(
      path,
      status,
      snippet.length > 0 ? snippet : "响应体不是合法 JSON",
      headers,
      status,
    );
  }

  // 3. 信封结构
  const envelope = ApiEnvelopeSchema.safeParse(parsedJson);
  if (!envelope.success) {
    return failureFor(path, status, "响应体不符合 { code, message, data } 信封", headers, status);
  }

  const { code, message, data } = envelope.data;

  // 4. 业务失败
  const isAgent = isAgentPath(path);
  const succeeded = isAgent ? code === AGENT_OK_CODE : code === AGENT_OK_CODE || code === "0";
  if (!succeeded) {
    return failureFor(path, status, message, headers, code);
  }

  // 5. data 契约校验
  const decoded = dataSchema.safeParse(data);
  if (!decoded.success) {
    return failureFor(path, status, message, headers, AGENT_ERROR_CODES.INTERNAL_ERROR);
  }

  return {
    ok: true,
    notModified: false,
    status,
    code: AGENT_OK_CODE,
    message,
    data: decoded.data,
    headers,
  };
}

/* -------------------------------------------------------------------------- */
/* 便捷判别                                                                     */
/* -------------------------------------------------------------------------- */

/** 是否为成功（含 304）。 */
export function isOk<T>(result: Unpacked<T>): result is ApiSuccess<T> | ApiNotModified {
  return result.ok;
}

/** 是否为 Agent 组失败（整数码）。 */
export function isAgentFailure<T>(result: Unpacked<T>): result is AgentFailure {
  return !result.ok && result.kind === "agent";
}

/** 是否为后台组失败（字符串码）。 */
export function isBackofficeFailure<T>(result: Unpacked<T>): result is BackofficeFailure {
  return !result.ok && result.kind === "backoffice";
}

/**
 * 解包成功结果；失败时抛出携带完整结果的错误。
 *
 * 供「失败即异常」风格的调用点使用；偏好显式分流的调用方直接用 `decodeEnvelope`。
 */
export function unwrap<T>(result: Unpacked<T>): T {
  if (!result.ok) {
    throw new ApiError(result);
  }
  if (result.notModified) {
    throw new ApiError(result);
  }
  return result.data;
}

/** 解包失败或 304 时抛出的错误（`unwrap()` 使用）。 */
export class ApiError extends Error {
  readonly result: AgentFailure | BackofficeFailure | ApiNotModified;

  constructor(result: AgentFailure | BackofficeFailure | ApiNotModified) {
    const isNotModified = "notModified" in result && result.notModified;
    super(
      isNotModified
        ? "资源未变更（304），无响应体可解包"
        : `API 调用失败（${String(result.status)}）：${result.message}`,
    );
    this.name = "ApiError";
    this.result = result;
  }

  /** 失败码（`304` 时为 `null`）。 */
  get code(): number | string | null {
    const result = this.result;
    return "notModified" in result && result.notModified ? null : result.code;
  }
}

/** `unwrap()` 抛出错误的别名（语义更贴近调用点）。 */
export { ApiError as UnwrapError };

/* -------------------------------------------------------------------------- */
/* 失败形态的 Zod schema（供调用方与测试断言形状）                                */
/* -------------------------------------------------------------------------- */

/** `AgentFailure` 的 Zod schema。 */
export const AgentFailureSchema = z.object({
  ok: z.literal(false),
  kind: z.literal("agent"),
  code: AgentErrorCodeSchema,
  rawCode: z.number().int(),
  retryAfterSeconds: z.number().int().nonnegative().nullable(),
  status: z.number().int(),
  message: z.string(),
  headers: z.instanceof(Headers),
});

/** `BackofficeFailure` 的 Zod schema。 */
export const BackofficeFailureSchema = z.object({
  ok: z.literal(false),
  kind: z.literal("backoffice"),
  code: z.string(),
  status: z.number().int(),
  message: z.string(),
  headers: z.instanceof(Headers),
});
