import { describe, expect, it } from "vitest";

import {
  PASSWORD_HASH_REGEX,
  PBKDF2_DERIVED_KEY_BYTES,
  PBKDF2_ITERATIONS,
  PBKDF2_SALT_BYTES,
  hashPassword,
  isPasswordHashFormat,
  parsePasswordHash,
  verifyPassword,
} from "../src/index.js";

describe("password (PBKDF2-SHA256)", () => {
  it("hash 格式匹配 pbkdf2$sha256$100000$<salt>$<key>", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(stored).toMatch(
      /^pbkdf2\$sha256\$100000\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/u,
    );
    expect(stored).toMatch(PASSWORD_HASH_REGEX);
    expect(stored.startsWith(`pbkdf2$sha256$${PBKDF2_ITERATIONS}$`)).toBe(true);
  });

  it("正确口令 true / 错误口令 false", async () => {
    const stored = await hashPassword("s3cret-p@ss");
    await expect(verifyPassword("s3cret-p@ss", stored)).resolves.toBe(true);
    await expect(verifyPassword("s3cret-p@ss ", stored)).resolves.toBe(false);
    await expect(verifyPassword("", stored)).resolves.toBe(false);
  });

  it("损坏 / 非法存储串返回 false（不抛）", async () => {
    const cases = [
      "",
      "plaintext",
      "pbkdf2$sha256$100000$onlyfour",
      "pbkdf2$sha256$100000$salt$key$extra",
      "argon2id$sha256$100000$c2FsdA$a2V5",
      "pbkdf2$sha512$100000$c2FsdA$a2V5",
      "pbkdf2$sha256$0$c2FsdA$a2V5",
      "pbkdf2$sha256$100000$$a2V5",
      "pbkdf2$sha256$abc$c2FsdA$a2V5",
      "pbkdf2$sha256$100000$not base64!$a2V5",
    ];
    for (const stored of cases) {
      await expect(verifyPassword("whatever", stored)).resolves.toBe(false);
    }
  });

  it("同一口令两次 hash 不同（salt 随机）且都能验过", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
    await expect(verifyPassword("same-password", a)).resolves.toBe(true);
    await expect(verifyPassword("same-password", b)).resolves.toBe(true);
  });

  it("salt 16 字节、派生 32 字节、迭代 100000", async () => {
    const parsed = parsePasswordHash(await hashPassword("x"));
    expect(parsed).not.toBeNull();
    expect(parsed?.salt.length).toBe(PBKDF2_SALT_BYTES);
    expect(parsed?.derivedKey.length).toBe(PBKDF2_DERIVED_KEY_BYTES);
    expect(parsed?.iterations).toBe(PBKDF2_ITERATIONS);
  });

  it("isPasswordHashFormat 只接受受支持格式", async () => {
    expect(isPasswordHashFormat(await hashPassword("x"))).toBe(true);
    expect(isPasswordHashFormat("bcrypt$2b$10$abcdefghijklmnopqrstuv")).toBe(false);
  });
});
