import { describe, expect, it } from "vitest";

import {
  PASSWORD_HASH_REGEX,
  PBKDF2_DERIVED_KEY_BYTES,
  PBKDF2_ITERATIONS,
  PBKDF2_SALT_BYTES,
  hashPassword,
  isPasswordHashFormat,
  parsePasswordHash,
  upgradePasswordHash,
  verifyPassword,
  verifyPasswordBoolean,
  verifyPasswordDetailed,
  PASSWORD_ALGORITHM,
} from "../src/index.js";
describe("password (PBKDF2-SHA256)", () => {
  it("hash 格式匹配 pbkdf2$sha256$100000$<salt>$<key>", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(stored).toMatch(/^pbkdf2\$sha256\$100000\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/u);
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

/** 既有格式的固定哈希（`pbkdf2$sha256$100000$...`，由现有实现现场派生，用于格式兼容回归）。 */
const LEGACY_FIXED_HASH =
  "pbkdf2$sha256$100000$BwcHBwcHBwcHBwcHBwcHBw$L1U-q2ApcN8-qcNIEQqmbdBSgeOo_XF8vufu6pzUxWU";

/** 低迭代次数的存量哈希（10000 次 < 推荐 100000 次），用于惰性升级判定。 */
async function hashWithIterations(password: string, iterations: number): Promise<string> {
  const salt = new Uint8Array(16).fill(3);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    keyMaterial,
    PBKDF2_DERIVED_KEY_BYTES * 8,
  );
  const b64u = (bytes: Uint8Array): string => {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
  };
  return `pbkdf2$sha256$${iterations}$${b64u(salt)}$${b64u(new Uint8Array(bits))}`;
}

describe("password 算法分派表（docs/04 升级缝 S3）", () => {
  it("已注册的算法前缀能被解析", () => {
    const parsed = parsePasswordHash(LEGACY_FIXED_HASH);
    expect(parsed).not.toBeNull();
    expect(parsed?.algorithm).toBe(PASSWORD_ALGORITHM);
    expect(parsed?.digest).toBe("sha256");
  });

  it("未注册的算法前缀明确拒绝（负向控制）", async () => {
    const unregistered = [
      "argon2id$sha256$100000$c2FsdA$a2V5",
      "scrypt$sha256$100000$c2FsdA$a2V5",
      "bcrypt$sha256$100000$c2FsdA$a2V5",
    ];
    for (const stored of unregistered) {
      expect(parsePasswordHash(stored)).toBeNull();
      expect(isPasswordHashFormat(stored)).toBe(false);
      await expect(verifyPasswordDetailed("whatever", stored)).resolves.toEqual({
        ok: false,
        needsRehash: false,
      });
      await expect(upgradePasswordHash("whatever", stored)).resolves.toBeNull();
    }
  });
});

describe("password 惰性升级（docs/04 升级缝 S3）", () => {
  it("低迭代存量哈希 → { ok: true, needsRehash: true }", async () => {
    const stored = await hashWithIterations("upgrade-me", 10_000);
    await expect(verifyPasswordDetailed("upgrade-me", stored)).resolves.toEqual({
      ok: true,
      needsRehash: true,
    });
    await expect(verifyPasswordBoolean("upgrade-me", stored)).resolves.toBe(true);
  });

  it("当前参数哈希 → { ok: true, needsRehash: false }", async () => {
    const stored = await hashPassword("current-params");
    await expect(verifyPasswordDetailed("current-params", stored)).resolves.toEqual({
      ok: true,
      needsRehash: false,
    });
  });

  it("错误密码 → { ok: false, needsRehash: false }", async () => {
    const stored = await hashPassword("right-password");
    await expect(verifyPasswordDetailed("wrong-password", stored)).resolves.toEqual({
      ok: false,
      needsRehash: false,
    });
  });

  it("upgradePasswordHash 需要升级时返回可验证的新哈希", async () => {
    const stored = await hashWithIterations("rotate-me", 10_000);
    const upgraded = await upgradePasswordHash("rotate-me", stored);
    expect(upgraded).not.toBeNull();
    expect(upgraded).toMatch(PASSWORD_HASH_REGEX);
    expect(upgraded?.startsWith(`pbkdf2$sha256$${PBKDF2_ITERATIONS}$`)).toBe(true);
    await expect(verifyPassword("rotate-me", upgraded ?? "")).resolves.toBe(true);
    await expect(verifyPasswordDetailed("rotate-me", upgraded ?? "")).resolves.toEqual({
      ok: true,
      needsRehash: false,
    });
  });

  it("upgradePasswordHash 不需要升级时返回 null", async () => {
    const stored = await hashPassword("already-fresh");
    await expect(upgradePasswordHash("already-fresh", stored)).resolves.toBeNull();
    await expect(upgradePasswordHash("wrong", stored)).resolves.toBeNull();
  });

  it("既有格式哈希升级前后都能验证通过", async () => {
    await expect(verifyPassword("correct horse battery staple", LEGACY_FIXED_HASH)).resolves.toBe(
      true,
    );
    await expect(
      verifyPasswordDetailed("correct horse battery staple", LEGACY_FIXED_HASH),
    ).resolves.toEqual({ ok: true, needsRehash: false });
    await expect(
      upgradePasswordHash("correct horse battery staple", LEGACY_FIXED_HASH),
    ).resolves.toBeNull();
  });
});
