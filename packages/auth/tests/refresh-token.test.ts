import { describe, expect, it } from "vitest";

import {
  REFRESH_TOKEN_BYTES,
  REFRESH_TOKEN_LENGTH,
  REFRESH_TOKEN_REGEX,
  generateRefreshToken,
  hashRefreshToken,
  isRefreshTokenFormat,
} from "../src/index.js";

describe("refresh token", () => {
  it("常量：32 字节 → 43 字符 base64url", () => {
    expect(REFRESH_TOKEN_BYTES).toBe(32);
    expect(REFRESH_TOKEN_LENGTH).toBe(43);
  });

  it("生成的明文是 43 字符 base64url", () => {
    for (let i = 0; i < 20; i += 1) {
      const token = generateRefreshToken();
      expect(token).toHaveLength(REFRESH_TOKEN_LENGTH);
      expect(token).toMatch(REFRESH_TOKEN_REGEX);
      expect(isRefreshTokenFormat(token)).toBe(true);
    }
  });

  it("两次生成不同", () => {
    expect(generateRefreshToken()).not.toBe(generateRefreshToken());
  });

  it("hashRefreshToken 稳定、hex 64、且等于 SHA-256", async () => {
    const token = generateRefreshToken();
    const a = await hashRefreshToken(token);
    const b = await hashRefreshToken(token);
    expect(a).toMatch(/^[0-9a-f]{64}$/u);
    expect(a).toBe(b);

    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
    );
    const expected = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    expect(a).toBe(expected);
  });

  it("不同 token 哈希不同", async () => {
    expect(await hashRefreshToken(generateRefreshToken())).not.toBe(
      await hashRefreshToken(generateRefreshToken()),
    );
  });

  it("isRefreshTokenFormat 拒绝非法串", () => {
    expect(isRefreshTokenFormat("")).toBe(false);
    expect(isRefreshTokenFormat("short")).toBe(false);
    expect(isRefreshTokenFormat("a".repeat(44))).toBe(false);
    expect(isRefreshTokenFormat(`${"a".repeat(42)}=`)).toBe(false);
  });
});
