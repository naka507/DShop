import { describe, expect, it } from "vitest";

import {
  AGENT_SIGNATURE_MAX_SKEW_SECONDS,
  BASE62_ALPHABET,
  SERVICE_TOKEN_BODY_LENGTH,
  SERVICE_TOKEN_CHECKSUM_LENGTH,
  SERVICE_TOKEN_CHECKSUM_MODULUS,
  SERVICE_TOKEN_DEFAULT_RATE_LIMIT_PER_MIN,
  SERVICE_TOKEN_PREFIX,
  SERVICE_TOKEN_PREFIX_LENGTH,
  SERVICE_TOKEN_REGEX,
  SERVICE_TOKEN_TOTAL_LENGTH,
  generateServiceToken,
  hashServiceToken,
  isServiceTokenFormat,
  serviceTokenBody,
  serviceTokenChecksum,
  serviceTokenPrefix,
  signAgentRequest,
  verifyAgentRequestSignature,
  verifyServiceToken,
} from "../src/index.js";

const PEPPER = "test-agent-token-pepper";

describe("service token", () => {
  it("BASE62_ALPHABET 固定为 0-9A-Za-z", () => {
    expect(BASE62_ALPHABET).toBe("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz");
    expect(BASE62_ALPHABET).toHaveLength(62);
  });

  it("常量与 docs/07 §7.8.1 一致", () => {
    expect(SERVICE_TOKEN_PREFIX).toBe("dshop_svc_");
    expect(SERVICE_TOKEN_BODY_LENGTH).toBe(24);
    expect(SERVICE_TOKEN_CHECKSUM_LENGTH).toBe(6);
    expect(SERVICE_TOKEN_PREFIX_LENGTH).toBe(16);
    expect(SERVICE_TOKEN_TOTAL_LENGTH).toBe(41);
    expect(SERVICE_TOKEN_CHECKSUM_MODULUS).toBe(62 ** 6);
    expect(SERVICE_TOKEN_DEFAULT_RATE_LIMIT_PER_MIN).toBe(600);
    expect(AGENT_SIGNATURE_MAX_SKEW_SECONDS).toBe(300);
  });

  it("生成的明文通过严格格式校验，长度 41，前缀 dshop_svc_", () => {
    for (let i = 0; i < 50; i += 1) {
      const token = generateServiceToken();
      expect(token).toMatch(SERVICE_TOKEN_REGEX);
      expect(token).toHaveLength(SERVICE_TOKEN_TOTAL_LENGTH);
      expect(token.startsWith(SERVICE_TOKEN_PREFIX)).toBe(true);
      expect(isServiceTokenFormat(token)).toBe(true);
    }
  });

  it("serviceTokenPrefix：长度 16 且是明文前缀", () => {
    const token = generateServiceToken();
    const prefix = serviceTokenPrefix(token);
    expect(prefix).toHaveLength(16);
    expect(token.startsWith(prefix)).toBe(true);
    expect(prefix).toBe(`dshop_svc_${token.slice(10, 16)}`);
  });

  it("serviceTokenBody 拆出 24 位随机体", () => {
    const token = generateServiceToken();
    const body = serviceTokenBody(token);
    expect(body).not.toBeNull();
    expect(body).toHaveLength(24);
    expect(body).toMatch(/^[0-9A-Za-z]{24}$/u);
    expect(token).toBe(`${SERVICE_TOKEN_PREFIX}${body ?? ""}_${serviceTokenChecksum(body ?? "")}`);
  });

  it("isServiceTokenFormat：篡改校验位 → false；篡改随机体 → false", () => {
    const token = generateServiceToken();
    const body = serviceTokenBody(token) ?? "";
    const checksum = token.slice(10 + 24 + 1);

    // 逐字符翻转校验位（确保真的变了）
    for (let i = 0; i < checksum.length; i += 1) {
      const original = checksum.charAt(i);
      const replacement = original === "0" ? "1" : "0";
      const tampered = `${SERVICE_TOKEN_PREFIX}${body}_${checksum.slice(0, i)}${replacement}${checksum.slice(i + 1)}`;
      expect(tampered).not.toBe(token);
      expect(isServiceTokenFormat(tampered)).toBe(false);
    }

    // 改随机体（校验位不变）→ 校验位失配
    const flipped = body.charAt(0) === "0" ? `1${body.slice(1)}` : `0${body.slice(1)}`;
    const tamperedBody = `${SERVICE_TOKEN_PREFIX}${flipped}_${checksum}`;
    expect(tamperedBody).not.toBe(token);
    expect(isServiceTokenFormat(tamperedBody)).toBe(false);
  });

  it("isServiceTokenFormat：结构不符一律 false（不只测正则）", () => {
    const cases = [
      "",
      "dshop_svc_",
      "dshop_svc_abc_def",
      `dshop_svc_${"a".repeat(23)}_000000`,
      `dshop_svc_${"a".repeat(25)}_000000`,
      `dshop_svc_${"a".repeat(24)}_00000`,
      `dshop_svc_${"a".repeat(24)}_0000000`,
      `dshop_svc_${"a".repeat(24)}-000000`,
      `dshop_svc_${"a".repeat(24)}_!!!!!!`,
      `DSHOP_SVC_${"a".repeat(24)}_000000`,
      `${"a".repeat(24)}_000000`,
      "not-a-token",
    ];
    for (const candidate of cases) {
      expect(isServiceTokenFormat(candidate)).toBe(false);
    }
    // 正则单独看：结构合法但校验位错的串，正则会过、格式校验不过
    expect(SERVICE_TOKEN_REGEX.test(`dshop_svc_${"a".repeat(24)}_000000`)).toBe(true);
    expect(isServiceTokenFormat(`dshop_svc_${"a".repeat(24)}_000000`)).toBe(false);
  });

  it("校验位算法可复现且与 SHA-256 前 4 字节一致", async () => {
    const body = "0123456789ABCDEFGHIJKLMn";
    const checksum = serviceTokenChecksum(body);
    expect(checksum).toHaveLength(6);
    expect(checksum).toMatch(/^[0-9A-Za-z]{6}$/u);

    // 独立重算：WebCrypto SHA-256 前 4 字节大端 uint32 % 62^6，再 base62 定长 6 位
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)),
    );
    const uint32 =
      (((digest[0] ?? 0) << 24) |
        ((digest[1] ?? 0) << 16) |
        ((digest[2] ?? 0) << 8) |
        (digest[3] ?? 0)) >>>
      0;
    let rest = uint32 % SERVICE_TOKEN_CHECKSUM_MODULUS;
    let expected = "";
    for (let i = 0; i < 6; i += 1) {
      expected = BASE62_ALPHABET.charAt(rest % 62) + expected;
      rest = Math.floor(rest / 62);
    }
    expect(checksum).toBe(expected);
  });

  it("hash/verify 往返；错误 pepper / 错误 token 不通过", async () => {
    const token = generateServiceToken();
    const hash = await hashServiceToken(PEPPER, token);

    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    await expect(verifyServiceToken(PEPPER, token, hash)).resolves.toBe(true);
    await expect(verifyServiceToken("other-pepper", token, hash)).resolves.toBe(false);
    await expect(verifyServiceToken(PEPPER, generateServiceToken(), hash)).resolves.toBe(false);
    await expect(verifyServiceToken(PEPPER, token, hash.toUpperCase())).resolves.toBe(true);
    await expect(verifyServiceToken(PEPPER, token, "deadbeef")).resolves.toBe(false);
  });

  it("hashServiceToken 与 HMAC-SHA256(pepper, token) 逐字一致", async () => {
    const token = generateServiceToken();
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(PEPPER),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const expected = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token)),
    );
    const hex = [...expected].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    await expect(hashServiceToken(PEPPER, token)).resolves.toBe(hex);
  });

  it("可选请求签名：往返通过、超时拒绝、篡改拒绝", async () => {
    const signSecret = "agent-sign-secret";
    const ts = "1767000000";
    const nowMs = Number(ts) * 1000 + 1000;
    const sig = await signAgentRequest(signSecret, ts, "GET", "/api/v1/agent/orders", "?limit=5");
    expect(sig).toMatch(/^[0-9a-f]{64}$/u);

    await expect(
      verifyAgentRequestSignature(
        signSecret,
        ts,
        "GET",
        "/api/v1/agent/orders",
        "?limit=5",
        sig,
        nowMs,
      ),
    ).resolves.toBe(true);

    // 偏离 > 300s
    await expect(
      verifyAgentRequestSignature(
        signSecret,
        ts,
        "GET",
        "/api/v1/agent/orders",
        "?limit=5",
        sig,
        Number(ts) * 1000 + 301_000,
      ),
    ).resolves.toBe(false);

    // 篡改 path
    await expect(
      verifyAgentRequestSignature(
        signSecret,
        ts,
        "GET",
        "/api/v1/agent/products",
        "?limit=5",
        sig,
        nowMs,
      ),
    ).resolves.toBe(false);

    // 非数字 timestamp
    await expect(
      verifyAgentRequestSignature(signSecret, "abc", "GET", "/x", "", sig, nowMs),
    ).resolves.toBe(false);
  });
});
