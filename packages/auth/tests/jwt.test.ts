import { describe, expect, it } from "vitest";

import { JWT_AUDIENCE } from "@dshop/shared";

import {
  ACCESS_TOKEN_TTL_SECONDS,
  JWT_ALGORITHM,
  REFRESH_TOKEN_TTL_SECONDS,
  decodeJwtUnsafe,
  signJwt,
  verifyJwt,
  type JwtPayload,
} from "../src/index.js";

const SECRET = "test-jwt-secret-32-bytes-minimum!!";
const BASE_MS = Date.UTC(2026, 8, 20, 6, 30, 0);

function b64urlDecode(value: string): string {
  return atob(value.replace(/-/g, "+").replace(/_/g, "/"));
}

function b64urlEncode(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function tamperPayload(token: string, mutate: (claims: Record<string, unknown>) => void): string {
  const [header, payload, signature] = token.split(".");
  const claims = JSON.parse(b64urlDecode(payload ?? "")) as Record<string, unknown>;
  mutate(claims);
  return `${header}.${b64urlEncode(JSON.stringify(claims))}.${signature}`;
}

describe("jwt (HS256)", () => {
  it("常量符合 docs/09 §9.1", () => {
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(7200);
    expect(REFRESH_TOKEN_TTL_SECONDS).toBe(1209600);
    expect(JWT_ALGORITHM).toBe("HS256");
  });

  it("签验往返：claims 完整保留", async () => {
    const token = await signJwt(
      {
        sub: "01J9Z8K2M4N5P6Q7R8S9T0V1W2",
        role: "merchant_admin",
        mid: "01MERCHANT0000000000000000",
      },
      SECRET,
      { aud: JWT_AUDIENCE.MERCHANT, nowMs: BASE_MS },
    );
    expect(token.split(".")).toHaveLength(3);

    const claims = await verifyJwt<JwtPayload>(token, SECRET, { nowMs: BASE_MS });
    expect(claims).not.toBeNull();
    expect(claims?.sub).toBe("01J9Z8K2M4N5P6Q7R8S9T0V1W2");
    expect(claims?.aud).toBe("merchant");
    expect(claims?.role).toBe("merchant_admin");
    expect(claims?.mid).toBe("01MERCHANT0000000000000000");
    expect(claims?.iat).toBe(Math.floor(BASE_MS / 1000));
    expect(claims?.exp).toBe(Math.floor(BASE_MS / 1000) + ACCESS_TOKEN_TTL_SECONDS);
    expect(typeof claims?.jti).toBe("string");
    expect((claims?.jti ?? "").length).toBeGreaterThan(0);
  });

  it("aud 不符返回 null；匹配则通过", async () => {
    const token = await signJwt({ sub: "u1", role: "customer" }, SECRET, {
      aud: JWT_AUDIENCE.SHOP,
      nowMs: BASE_MS,
    });
    await expect(
      verifyJwt(token, SECRET, { expectedAud: JWT_AUDIENCE.SHOP, nowMs: BASE_MS }),
    ).resolves.not.toBeNull();
    await expect(
      verifyJwt(token, SECRET, { expectedAud: JWT_AUDIENCE.ADMIN, nowMs: BASE_MS }),
    ).resolves.toBeNull();
    await expect(
      verifyJwt(token, SECRET, { expectedAud: JWT_AUDIENCE.MERCHANT, nowMs: BASE_MS }),
    ).resolves.toBeNull();
  });

  it("篡改 payload 返回 null", async () => {
    const token = await signJwt({ sub: "u1", role: "customer" }, SECRET, {
      aud: JWT_AUDIENCE.SHOP,
      nowMs: BASE_MS,
    });
    const forged = tamperPayload(token, (claims) => {
      claims.role = "platform_super_admin";
    });
    expect(forged).not.toBe(token);
    await expect(verifyJwt(forged, SECRET, { nowMs: BASE_MS })).resolves.toBeNull();
  });

  it("篡改 aud 也返回 null（签名覆盖全载荷）", async () => {
    const token = await signJwt({ sub: "u1", role: "customer" }, SECRET, {
      aud: JWT_AUDIENCE.SHOP,
      nowMs: BASE_MS,
    });
    const forged = tamperPayload(token, (claims) => {
      claims.aud = "admin";
    });
    await expect(verifyJwt(forged, SECRET, { nowMs: BASE_MS })).resolves.toBeNull();
  });

  it("过期 token 返回 null", async () => {
    const issuedMs = BASE_MS;
    const token = await signJwt({ sub: "u1", role: "customer" }, SECRET, {
      aud: JWT_AUDIENCE.SHOP,
      expiresInSeconds: 60,
      nowMs: issuedMs,
    });
    await expect(verifyJwt(token, SECRET, { nowMs: issuedMs + 59_000 })).resolves.not.toBeNull();
    await expect(verifyJwt(token, SECRET, { nowMs: issuedMs + 61_000 })).resolves.toBeNull();
  });

  it("手工构造 exp 过去的 token 返回 null", async () => {
    const token = await signJwt({ sub: "u1", role: "customer" }, SECRET, {
      aud: JWT_AUDIENCE.SHOP,
      expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
      nowMs: BASE_MS,
    });
    const expired = tamperPayload(token, (claims) => {
      claims.exp = Math.floor(BASE_MS / 1000) - 3600;
    });
    // 篡改会破坏签名，另外再验「过期且签名有效的 token」：
    const realExpired = await signJwt({ sub: "u1", role: "customer" }, SECRET, {
      aud: JWT_AUDIENCE.SHOP,
      expiresInSeconds: 1,
      nowMs: BASE_MS - 10 * 60 * 1000,
    });
    await expect(verifyJwt(realExpired, SECRET, { nowMs: BASE_MS })).resolves.toBeNull();
    await expect(verifyJwt(expired, SECRET, { nowMs: BASE_MS })).resolves.toBeNull();
  });

  it("错误密钥 / 非法结构返回 null", async () => {
    const token = await signJwt({ sub: "u1", role: "customer" }, SECRET, {
      aud: JWT_AUDIENCE.SHOP,
      nowMs: BASE_MS,
    });
    await expect(verifyJwt(token, "other-secret", { nowMs: BASE_MS })).resolves.toBeNull();
    await expect(verifyJwt("not-a-jwt", SECRET, { nowMs: BASE_MS })).resolves.toBeNull();
    await expect(verifyJwt("a.b", SECRET, { nowMs: BASE_MS })).resolves.toBeNull();
    await expect(verifyJwt("", SECRET, { nowMs: BASE_MS })).resolves.toBeNull();
    await expect(verifyJwt("a.b.c", SECRET, { nowMs: BASE_MS })).resolves.toBeNull();
  });

  it("decodeJwtUnsafe 能读出载荷（不验签）", async () => {
    const token = await signJwt({ sub: "u1", role: "customer" }, SECRET, {
      aud: JWT_AUDIENCE.SHOP,
      nowMs: BASE_MS,
    });
    expect(decodeJwtUnsafe(token)?.sub).toBe("u1");
    expect(decodeJwtUnsafe("garbage")).toBeNull();
  });

  it("签名是 HMAC-SHA256（与 WebCrypto 结果一致）", async () => {
    const token = await signJwt({ sub: "u1", role: "customer" }, SECRET, {
      aud: JWT_AUDIENCE.SHOP,
      nowMs: BASE_MS,
      jti: "fixed-jti",
    });
    const [header, payload, signature] = token.split(".");
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const expected = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${header}.${payload}`)),
    );
    let binary = "";
    for (const byte of expected) binary += String.fromCharCode(byte);
    const expectedB64 = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
    expect(signature).toBe(expectedB64);
  });
});
