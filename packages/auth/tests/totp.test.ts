import { describe, expect, it } from "vitest";

import {
  TOTP_DEFAULT_WINDOW,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  TOTP_SECRET_BASE32_LENGTH,
  TOTP_SECRET_BYTES,
  generateTotpSecret,
  isValidTotpSecret,
  totpCode,
  totpProvisioningUri,
  verifyTotp,
} from "../src/index.js";

/**
 * RFC 6238 附录 B 官方测试向量（**SHA-1** 列）。
 *
 * secret = ASCII `"12345678901234567890"` 的 Base32 编码。
 * RFC 给的是 **8 位**结果；本实现是 **6 位**，故断言「8 位结果的末 6 位」。
 */
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

const RFC_VECTORS: readonly { readonly t: number; readonly eightDigits: string }[] = [
  { t: 59, eightDigits: "94287082" },
  { t: 1_111_111_109, eightDigits: "07081804" },
  { t: 1_111_111_111, eightDigits: "14050471" },
  { t: 1_234_567_890, eightDigits: "89005924" },
  { t: 2_000_000_000, eightDigits: "69279037" },
  { t: 20_000_000_000, eightDigits: "65353130" },
];

describe("totp (RFC 6238)", () => {
  it("常量：SHA-1 / 6 位 / 30s / ±1 窗口", () => {
    expect(TOTP_DIGITS).toBe(6);
    expect(TOTP_PERIOD_SECONDS).toBe(30);
    expect(TOTP_DEFAULT_WINDOW).toBe(1);
    expect(TOTP_SECRET_BYTES).toBe(20);
    expect(TOTP_SECRET_BASE32_LENGTH).toBe(32);
  });

  it.each(RFC_VECTORS)(
    "RFC 6238 附录 B：T=$t → 末 6 位 $eightDigits",
    async ({ t, eightDigits }) => {
      const code = await totpCode(RFC_SECRET, t * 1000);
      expect(code).toHaveLength(6);
      expect(code).toBe(eightDigits.slice(-6));
    },
  );

  it("generateTotpSecret：Base32 大写、32 字符、可解析回 20 字节", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/u);
    expect(secret).toHaveLength(TOTP_SECRET_BASE32_LENGTH);
    expect(isValidTotpSecret(secret)).toBe(true);
    expect(isValidTotpSecret("not base32 !!!")).toBe(false);
    expect(isValidTotpSecret("")).toBe(false);
  });

  it("两次 generateTotpSecret 不同", () => {
    expect(generateTotpSecret()).not.toBe(generateTotpSecret());
  });

  it("verifyTotp：当前窗口通过，±1 窗口通过，±2 窗口拒绝", async () => {
    const secret = generateTotpSecret();
    const nowMs = 1_700_000_000_000;

    const current = await totpCode(secret, nowMs);
    await expect(verifyTotp(secret, current, nowMs)).resolves.toBe(true);

    const previous = await totpCode(secret, nowMs - 30_000);
    await expect(verifyTotp(secret, previous, nowMs)).resolves.toBe(true);

    const next = await totpCode(secret, nowMs + 30_000);
    await expect(verifyTotp(secret, next, nowMs)).resolves.toBe(true);

    const twoBack = await totpCode(secret, nowMs - 60_000);
    await expect(verifyTotp(secret, twoBack, nowMs)).resolves.toBe(false);
    // window = 0 时只认当前窗口
    await expect(verifyTotp(secret, previous, nowMs, 0)).resolves.toBe(false);
  });

  it("verifyTotp：格式非法 / 错误码返回 false", async () => {
    const secret = generateTotpSecret();
    const nowMs = 1_700_000_000_000;
    await expect(verifyTotp(secret, "abcdef", nowMs)).resolves.toBe(false);
    await expect(verifyTotp(secret, "12345", nowMs)).resolves.toBe(false);
    await expect(verifyTotp(secret, "", nowMs)).resolves.toBe(false);
    await expect(verifyTotp(secret, "000000", nowMs)).resolves.toBe(false);
    await expect(verifyTotp("!!!invalid!!!", "123456", nowMs)).resolves.toBe(false);
  });

  it("totpCode：非法密钥抛 TypeError", async () => {
    await expect(totpCode("!!!!", 0)).rejects.toBeInstanceOf(TypeError);
    await expect(totpCode("", 0)).rejects.toBeInstanceOf(TypeError);
  });

  it("totpProvisioningUri 形状正确", () => {
    const uri = totpProvisioningUri("JBSWY3DPEHPK3PXP", "admin@dshop", "DShop");
    expect(uri.startsWith("otpauth://totp/DShop%3Aadmin%40dshop?")).toBe(true);
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
    expect(uri).toContain("algorithm=SHA1");
  });
});
