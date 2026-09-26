/**
 * 回调渠道密钥 / 公钥的读取（`docs/06` §6 / `docs/09` §9.1）。
 *
 * ## 为什么用结构化读取而不是直接 `env.WXPAY_*`
 *
 * `apps/api/src/env.ts` 的 `Env` 接口**本任务不可修改**（文件所有权约束），
 * 而 `docs/09` §9.1 的 secret 清单里回调密钥的绑定名**尚未登记进 `Env`**。
 * 故本模块以**结构化窄化**的方式读取（`Record<string, unknown>` + 类型守卫），
 * 既不用 `any`，也不与并行修改的 `env.ts` 产生冲突。
 *
 * ⚠️ **待主代理登记到 `env.ts` 的绑定名**（本实现读取的名字）：
 * - `WXPAY_PLATFORM_PUBLIC_KEY` —— 微信支付**平台证书公钥**（PEM，`spki`）；
 *   `docs/09` §9.1 只列了 `WXPAY_MCH_CERT`（商户证书）与 `WXPAY_V3_KEY`（APIv3 密钥），
 *   **未列平台公钥**——但 v3 验签必须要它（`callbacks.ts` 的验签步骤注释）。
 * - `WXPAY_V3_KEY` —— APIv3 密钥（32 字节），`resource` 的 `AEAD_AES_256_GCM` 解密用。
 * - `ALIPAY_PUBLIC_KEY` —— 支付宝公钥（PEM，`spki`），RSA2 验签用。
 * - `ALIPAY_APP_ID` —— 本应用 `app_id`（可选；配置后校验通知归属）。
 *
 * **公钥缺失时的行为**：验签一律失败 → `ERR_CALLBACK_SIGNATURE_INVALID`。
 * 这是**安全侧默认**：宁可拒真，不可收假。
 */

import type { Env } from "../../env.js";

/** 回调渠道密钥集合（全部可选，缺省即「未配置」）。 */
export interface CallbackSecrets {
  /** 微信支付平台证书公钥（PEM）。 */
  readonly wechatPlatformPublicKey: string | null;
  /** 微信支付 APIv3 密钥（32 字节明文）。 */
  readonly wechatApiV3Key: string | null;
  /** 支付宝公钥（PEM）。 */
  readonly alipayPublicKey: string | null;
  /** 本应用的支付宝 `app_id`。 */
  readonly alipayAppId: string | null;
}

/** 从 `unknown` 取非空字符串；非字符串或空串返回 `null`。 */
function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 读取回调密钥。
 *
 * `Env` 的字段名与 secret 绑定名一致（`docs/09` §9.1 的 `JWT_SECRET` 等），
 * 故这里按绑定名读取即可。
 */
export function readCallbackSecrets(env: Env): CallbackSecrets {
  const raw = env as unknown as Record<string, unknown>;
  return {
    wechatPlatformPublicKey: readString(raw, "WXPAY_PLATFORM_PUBLIC_KEY"),
    wechatApiV3Key: readString(raw, "WXPAY_V3_KEY"),
    alipayPublicKey: readString(raw, "ALIPAY_PUBLIC_KEY"),
    alipayAppId: readString(raw, "ALIPAY_APP_ID"),
  };
}
