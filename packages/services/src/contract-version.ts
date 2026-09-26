/**
 * 契约版本处理（`docs/07` §7.1）。
 *
 * 规格：
 * - 请求头 `X-Contract-Version`；**缺失视为 `1`**，并记录告警
 * - 显式声明不支持的版本 → HTTP 400 + 错误码 `40010`
 * - 响应头回显 `X-Contract-Version`
 */

/** 当前支持的契约版本。 */
export const CURRENT_CONTRACT_VERSION = "1";

/** 支持的契约版本集合。 */
export const SUPPORTED_CONTRACT_VERSIONS: readonly string[] = [CURRENT_CONTRACT_VERSION];

/** 契约版本请求头名。 */
export const CONTRACT_VERSION_HEADER = "X-Contract-Version";

/** 解析结果。 */
export interface ContractVersionResolution {
  readonly ok: boolean;
  /** 生效版本；`ok=false` 时无意义。 */
  readonly version: string;
  /** 请求头缺失（需记告警）。 */
  readonly missing: boolean;
  /** 原始请求头值。 */
  readonly raw: string | null;
}

/**
 * 解析并校验 `X-Contract-Version`。
 *
 * - 缺失 / 空串 → `{ ok: true, version: "1", missing: true }`
 * - 命中支持集合 → `{ ok: true, missing: false }`
 * - 其他 → `{ ok: false }`（调用方回 400 + 40010）
 */
export function resolveContractVersion(
  rawHeader: string | null | undefined,
): ContractVersionResolution {
  const raw = rawHeader === null || rawHeader === undefined ? null : rawHeader.trim();
  if (raw === null || raw.length === 0) {
    return { ok: true, version: CURRENT_CONTRACT_VERSION, missing: true, raw: null };
  }
  if (SUPPORTED_CONTRACT_VERSIONS.includes(raw)) {
    return { ok: true, version: raw, missing: false, raw };
  }
  return { ok: false, version: CURRENT_CONTRACT_VERSION, missing: false, raw };
}
