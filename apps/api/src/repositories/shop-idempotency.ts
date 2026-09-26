/**
 * 幂等键仓储（`docs/05` §5.3③、`docs/06` §6）。
 *
 * 表：`idempotency_keys`（`uq_idempotency_keys(scope, key)` 唯一）。
 *
 * 语义（`docs/05` §5.3③「下单」行）：**重放直接返回首次结果**。
 * 本实现据此定案：
 * - 首次请求 → `{ kind: "fresh" }`，调用方执行写入，完成后 `complete()` 落响应体
 * - 同 `key` 且 `request_hash` 相同、已有响应体 → `{ kind: "replay" }`，直接回首次结果
 * - 同 `key` 但 `request_hash` 不同 → `{ kind: "conflict" }`（`ERR_SHOP_IDEMPOTENCY_CONFLICT`）
 * - 同 `key` 且仍在处理中（`response_body` 为空）→ 也按 `conflict` 处理：
 *   并发重放无法安全地「等待首次结果」，返回 409 比返回空结果更诚实。
 *
 * `request_hash` 由调用方按「方法 + 路径 + 请求体规范化 JSON」计算，
 * 使「同 key 不同请求体」可被识别（`docs/06` §6 的幂等键语义）。
 */

/** 幂等键作用域（区分端点族，避免跨端点撞 key）。 */
export const IDEMPOTENCY_SCOPE = {
  /** `POST /api/v1/shop/orders`。 */
  SHOP_ORDER_CREATE: "shop:order:create",
  /** `POST /api/v1/shop/aftersales`。 */
  SHOP_AFTERSALE_CREATE: "shop:aftersale:create",
} as const;
export type IdempotencyScope = (typeof IDEMPOTENCY_SCOPE)[keyof typeof IDEMPOTENCY_SCOPE];

/** 幂等记录保留时长（**实现侧定案**：`docs` 未定义 TTL，取 24 小时）。 */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 3600;

/** 幂等检查结果。 */
export type IdempotencyOutcome<T> =
  | { readonly kind: "fresh" }
  | { readonly kind: "replay"; readonly response: T }
  | { readonly kind: "conflict"; readonly reason: string };

/** `idempotency_keys` 行（仅取本层需要的列）。 */
interface IdempotencyRow {
  readonly id: string;
  readonly request_hash: string | null;
  readonly response_body: string | null;
  readonly status: string;
}

/** 检查（并在首次请求时占位）幂等键。 */
export async function beginIdempotentRequest<T>(
  db: D1Database,
  input: {
    readonly scope: IdempotencyScope;
    readonly key: string;
    readonly requestHash: string;
    readonly newId: string;
    readonly nowMs: number;
  },
): Promise<IdempotencyOutcome<T>> {
  const existing = await db
    .prepare(
      `SELECT id, request_hash, response_body, status
         FROM idempotency_keys
        WHERE scope = ? AND key = ?
        LIMIT 1`,
    )
    .bind(input.scope, input.key)
    .first<IdempotencyRow>();

  if (existing !== null) {
    if (existing.request_hash !== null && existing.request_hash !== input.requestHash) {
      return { kind: "conflict", reason: "同一 Idempotency-Key 对应不同请求体" };
    }
    if (existing.response_body === null) {
      return { kind: "conflict", reason: "同一 Idempotency-Key 的首次请求仍在处理中" };
    }
    return { kind: "replay", response: JSON.parse(existing.response_body) as T };
  }

  const nowIso = new Date(input.nowMs).toISOString();
  const expiresAt = new Date(input.nowMs + IDEMPOTENCY_TTL_SECONDS * 1000).toISOString();

  try {
    await db
      .prepare(
        `INSERT INTO idempotency_keys
           (id, scope, key, request_hash, response_body, status, expires_at, created_at)
         VALUES (?, ?, ?, ?, NULL, 'processing', ?, ?)`,
      )
      .bind(input.newId, input.scope, input.key, input.requestHash, expiresAt, nowIso)
      .run();
  } catch {
    /*
     * 唯一约束冲突（并发同 key）：此时**不能**再插，也不该继续写入业务数据。
     * 返回 conflict —— 与「首次请求仍在处理中」同一语义。
     */
    return { kind: "conflict", reason: "同一 Idempotency-Key 已被并发请求占用" };
  }

  return { kind: "fresh" };
}

/** 首次请求成功后落响应体（供后续重放返回）。 */
export async function completeIdempotentRequest(
  db: D1Database,
  input: {
    readonly scope: IdempotencyScope;
    readonly key: string;
    readonly responseBody: string;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE idempotency_keys
          SET response_body = ?, status = 'completed'
        WHERE scope = ? AND key = ?`,
    )
    .bind(input.responseBody, input.scope, input.key)
    .run();
}

/**
 * 计算请求指纹（`scope` 之外的「同 key 不同请求体」判据）。
 *
 * 输入按**键排序的稳定 JSON** 序列化后再 SHA-256，保证同一请求体任意次调用
 * 得到同一指纹（对象键顺序不影响判定）。
 */
export function requestFingerprintOf(payload: unknown): string {
  return JSON.stringify(stableStringify(payload));
}

/** 稳定 JSON 序列化：对象键递归按字典序排序（与 `repositories/json.ts` 同规则）。 */
function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "null" : encoded;
}
