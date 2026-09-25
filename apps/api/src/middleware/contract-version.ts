/**
 * 契约版本中间件（`docs/07` §7.1）。
 *
 * - 缺失 `X-Contract-Version` → 视为 `1`，并输出告警日志
 * - 显式声明不支持的版本 → `400` + `40010`
 * - 所有响应回显 `X-Contract-Version`
 */

import type { MiddlewareHandler } from "hono";

import type { AppEnv } from "../lib/context.js";
import { unsupportedContractVersion } from "../lib/errors.js";
import { CONTRACT_VERSION_HEADER, resolveContractVersion } from "@dshop/services";

export const contractVersion = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const resolution = resolveContractVersion(c.req.header(CONTRACT_VERSION_HEADER));

  if (!resolution.ok) {
    return unsupportedContractVersion(
      `不支持的契约版本：${resolution.raw ?? "(空)"}，当前仅支持 ${resolution.version}`,
    );
  }

  if (resolution.missing) {
    // 缺失即告警（07 §7.1 要求记录告警，但不拒绝请求）
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "contract_version_missing",
        path: c.req.path,
        method: c.req.method,
        assumedVersion: resolution.version,
      }),
    );
  }

  c.set("contractVersion", resolution.version);
  await next();
  c.res.headers.set(CONTRACT_VERSION_HEADER, resolution.version);
};
