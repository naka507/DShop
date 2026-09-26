/**
 * 回调验签 / 解密的密码学原语（WebCrypto，`docs/08` §8.2）。
 *
 * **不接真实 SDK**（任务要求）：只用全局 `crypto.subtle` 实现：
 * - `verifyRsaSha256()` —— RSA-PKCS1-v1_5 + SHA-256（微信 v3 的 `SHA256withRSA`、支付宝的 `RSA2`）
 * - `decryptWechatResource()` —— `AEAD_AES_256_GCM`（微信 v3 `resource` 解密）
 *
 * 环境约束同 `@dshop/auth`：不引入 `node:crypto` / `Buffer`；统一用裸标识符 `crypto`。
 */

/* -------------------------------------------------------------------------- */
/* base64（标准，非 url-safe）                                                  */
/* -------------------------------------------------------------------------- */

/** base64（标准）→ 字节；非法返回 `null`。 */
function base64ToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/=]+$/u.test(value)) return null;
  try {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** 字节 → base64（标准，带 `=` padding）。 */
function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/* -------------------------------------------------------------------------- */
/* PEM → DER                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 解析 PEM 公钥为 DER 字节。
 *
 * 接受 `-----BEGIN PUBLIC KEY-----`（SubjectPublicKeyInfo，微信 / 支付宝公钥的标准形式）。
 *
 * ⚠️ 对 `-----BEGIN CERTIFICATE-----`（平台**证书**形式）返回 `null`：
 * X.509 证书解析需要完整的 ASN.1 解析器，超出「不接真实 SDK」的边界。
 * 平台公钥请以 `PUBLIC KEY` 形式配置（见 `secrets.ts` 的说明）。
 */
export function publicKeyDerFromPem(pem: string): Uint8Array | null {
  const trimmed = pem.trim();
  if (trimmed.includes("BEGIN CERTIFICATE")) return null;
  const body = trimmed
    .replace(/-----BEGIN [^-]+-----/gu, "")
    .replace(/-----END [^-]+-----/gu, "")
    .replace(/\s+/gu, "");
  if (body.length === 0) return null;
  return base64ToBytes(body);
}

/* -------------------------------------------------------------------------- */
/* RSA-SHA256 验签                                                             */
/* -------------------------------------------------------------------------- */

/** 导入 RSA 公钥（`spki`，用于 `verify`）。 */
async function importRsaPublicKey(der: Uint8Array): Promise<CryptoKey | null> {
  try {
    return await crypto.subtle.importKey(
      "spki",
      der,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch {
    return null;
  }
}

/**
 * RSA-SHA256 验签（PKCS#1 v1.5）。
 *
 * @param publicKeyPem 公钥 PEM（`PUBLIC KEY` 形式）
 * @param message      被签名的明文（微信为 `timestamp\nnonce\nbody\n`；支付宝为待签串）
 * @param signatureB64 签名值（标准 base64）
 * @returns 公钥不可用 / 签名非 base64 / 验签不通过，**一律 `false`**（不抛）
 */
export async function verifyRsaSha256(
  publicKeyPem: string,
  message: string,
  signatureB64: string,
): Promise<boolean> {
  const der = publicKeyDerFromPem(publicKeyPem);
  if (der === null) return false;
  const key = await importRsaPublicKey(der);
  if (key === null) return false;
  const signature = base64ToBytes(signatureB64);
  if (signature === null) return false;
  try {
    return await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signature,
      new TextEncoder().encode(message),
    );
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* AES-256-GCM 解密（微信 v3 resource）                                        */
/* -------------------------------------------------------------------------- */

/**
 * `AEAD_AES_256_GCM` 解密（微信 v3 回调 `resource`）。
 *
 * 参数映射（`callbacks.ts` 的 `WechatPayCallbackBodySchema`）：
 * - 密钥 = `WXPAY_V3_KEY`（32 字节 UTF-8）
 * - IV = `resource.nonce`（base64 解码，12 字节）
 * - AAD = `resource.associated_data`（UTF-8 原文，可为空串）
 * - 密文 = `resource.ciphertext`（base64 解码，**尾部 16 字节为 GCM tag**）
 *
 * 失败（密钥缺失 / 密钥非 32 字节 / base64 非法 / tag 校验失败）一律返回 `null`。
 */
export async function decryptWechatResource(input: {
  readonly apiV3Key: string | null;
  readonly nonce: string;
  readonly associatedData: string;
  readonly ciphertext: string;
}): Promise<string | null> {
  if (input.apiV3Key === null) return null;
  const keyBytes = new TextEncoder().encode(input.apiV3Key);
  if (keyBytes.length !== 32) return null;

  const iv = base64ToBytes(input.nonce);
  const payload = base64ToBytes(input.ciphertext);
  if (iv === null || payload === null || payload.length <= 16) return null;

  const ciphertext = payload.subarray(0, payload.length - 16);
  const tag = payload.subarray(payload.length - 16);

  try {
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, [
      "decrypt",
    ]);
    // WebCrypto 的 AES-GCM 要求 `tagLength` 以**位**计，128 位即 16 字节
    const plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: new TextEncoder().encode(input.associatedData),
        tagLength: 128,
      },
      key,
      // 规范要求密文与 tag 拼接后传入
      new Uint8Array([...ciphertext, ...tag]),
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* 支付宝待签串                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * 支付宝异步通知的待签串：除 `sign` / `sign_type` 外的字段按**键字典序**拼成 `k=v&k=v`。
 *
 * 空值字段**不参与**拼接（支付宝规范：值为空则不参与签名）。
 */
export function buildAlipaySignContent(fields: Readonly<Record<string, string>>): string {
  return Object.keys(fields)
    .filter((key) => key !== "sign" && key !== "sign_type")
    .filter((key) => (fields[key] ?? "").length > 0)
    .sort()
    .map((key) => `${key}=${fields[key] ?? ""}`)
    .join("&");
}

/** 供测试构造签名：字节 → base64（标准）。 */
export { base64FromBytes };
