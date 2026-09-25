import { describe, expect, it } from "vitest";

import {
  PHONE_REGEX,
  PII_AES_GCM_IV_BYTES,
  PII_AES_KEY_BYTES,
  PII_ENVELOPE_VERSION,
  decryptPii,
  encryptPii,
  hashPhone,
  isPiiEnvelope,
  normalizePhone,
  verifyPhoneHash,
} from "../src/index.js";

const PEPPER = "test-phone-hash-pepper";
const KEY = "test-pii-encryption-key-material";

describe("pii — normalizePhone", () => {
  it("+86 138-0013-8000 → 13800138000", () => {
    expect(normalizePhone("+86 138-0013-8000")).toBe("13800138000");
  });

  it("容忍各种书写形式", () => {
    expect(normalizePhone("13800138000")).toBe("13800138000");
    expect(normalizePhone("138 0013 8000")).toBe("13800138000");
    expect(normalizePhone("8613800138000")).toBe("13800138000");
    expect(normalizePhone("+8613800138000")).toBe("13800138000");
    expect(normalizePhone("008613800138000")).toBe("13800138000");
    expect(normalizePhone("  +86-138-0013-8000  ")).toBe("13800138000");
    expect(normalizePhone("(138)0013-8000")).toBe("13800138000");
  });

  it("非法输入 → null", () => {
    const invalid = [
      "",
      "   ",
      "1380013800",
      "138001380000",
      "23800138000",
      "1380013800a",
      "abc",
      "013800138000",
      "86",
      "+",
      "++8613800138000",
      "not-a-phone",
    ];
    for (const input of invalid) {
      expect(normalizePhone(input)).toBeNull();
    }
  });

  it("PHONE_REGEX：11 位、1 开头", () => {
    expect(PHONE_REGEX.test("13800138000")).toBe(true);
    expect(PHONE_REGEX.test("1380013800")).toBe(false);
    expect(PHONE_REGEX.test("23800138000")).toBe(false);
    expect(PHONE_REGEX.test("138001380000")).toBe(false);
  });

  it("hashPhone 稳定、hex 64、错误 pepper 不同", async () => {
    const a = await hashPhone(PEPPER, "13800138000");
    const b = await hashPhone(PEPPER, "+86 138-0013-8000");
    const c = await hashPhone("other-pepper", "13800138000");

    expect(a).toMatch(/^[0-9a-f]{64}$/u);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("hashPhone 非法手机号抛 TypeError", async () => {
    await expect(hashPhone(PEPPER, "not-a-phone")).rejects.toBeInstanceOf(TypeError);
  });

  it("verifyPhoneHash：命中 / 未命中 / 非法输入", async () => {
    const hash = await hashPhone(PEPPER, "13800138000");
    await expect(verifyPhoneHash(PEPPER, "+86 138-0013-8000", hash)).resolves.toBe(true);
    await expect(verifyPhoneHash(PEPPER, "13900139000", hash)).resolves.toBe(false);
    await expect(verifyPhoneHash("other-pepper", "13800138000", hash)).resolves.toBe(false);
    await expect(verifyPhoneHash(PEPPER, "bad", hash)).resolves.toBe(false);
  });
});

describe("pii — AES-256-GCM", () => {
  it("常量与 docs 定案一致", () => {
    expect(PII_ENVELOPE_VERSION).toBe("v1");
    expect(PII_AES_GCM_IV_BYTES).toBe(12);
    expect(PII_AES_KEY_BYTES).toBe(32);
  });

  it("加解密往返（含中文 / emoji / 空串）", async () => {
    const cases = ["13800138000", "浙江省 杭州市 西湖区 文三路 100 号", "张三 🙂", ""];
    for (const plaintext of cases) {
      const payload = await encryptPii(KEY, plaintext);
      expect(payload.startsWith("v1.")).toBe(true);
      expect(payload.split(".")).toHaveLength(3);
      await expect(decryptPii(KEY, payload)).resolves.toBe(plaintext);
    }
  });

  it("同一明文两次密文不同（IV 随机）", async () => {
    const a = await encryptPii(KEY, "13800138000");
    const b = await encryptPii(KEY, "13800138000");
    expect(a).not.toBe(b);
    await expect(decryptPii(KEY, a)).resolves.toBe("13800138000");
    await expect(decryptPii(KEY, b)).resolves.toBe("13800138000");
  });

  it("错误密钥 / 篡改密文 / 结构非法 → null", async () => {
    const payload = await encryptPii(KEY, "13800138000");
    const parts = payload.split(".");
    const iv = parts[1] ?? "";
    const cipher = parts[2] ?? "";

    await expect(decryptPii("wrong-key", payload)).resolves.toBeNull();
    await expect(decryptPii(KEY, "v2.a.b")).resolves.toBeNull();
    await expect(decryptPii(KEY, "v1.only-two")).resolves.toBeNull();
    await expect(decryptPii(KEY, "")).resolves.toBeNull();
    await expect(decryptPii(KEY, "v1.!!!!.!!!!")).resolves.toBeNull();
    // 截断密文（丢掉认证标签尾部）→ 认证失败
    await expect(decryptPii(KEY, `v1.${iv}.${cipher.slice(0, 8)}`)).resolves.toBeNull();
    // 篡改 IV
    await expect(decryptPii(KEY, `v1.${iv.slice(0, -1)}A.${cipher}`)).resolves.toBeNull();
  });

  it("isPiiEnvelope 仅做结构判定", async () => {
    const payload = await encryptPii(KEY, "x");
    expect(isPiiEnvelope(payload)).toBe(true);
    expect(isPiiEnvelope("v2.a.b")).toBe(false);
    expect(isPiiEnvelope("nope")).toBe(false);
    expect(isPiiEnvelope("v1.!!!.!!!")).toBe(false);
  });
});
