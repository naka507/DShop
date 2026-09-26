/**
 * C 端会员仓储（`docs/06` §6 的 `/api/v1/shop/auth/*` 与 `/shop/addresses`）。
 *
 * 表：`users`、`user_addresses`、`settings`（验证码暂存，见文末缺口说明）。
 *
 * ⚠️ PII 口径（`docs/05` §5.2）：
 * - `users.phone` 与 `user_addresses.receiver_phone` 均为**加密列**（AES-GCM，
 *   密钥 `PHONE_ENC_KEY`），写入前 `encryptPii()`，读出后 `decryptPii()`。
 * - `users.phone_hash` = `HMAC-SHA256(PHONE_HASH_PEPPER, 规范化11位)`，供等值查询。
 *
 * ⚠️ C 端登录即注册：`docs/08` §8.1 未定义独立的注册端点，首次验证码登录时
 * 若 `phone_hash` 不存在则**建号**（`users.status = 'active'`）。
 */

import { decryptPii, encryptPii, hashPhone, normalizePhone } from "@dshop/auth";
import { USER_STATUS } from "@dshop/shared";

/* -------------------------------------------------------------------------- */
/* 行类型                                                                       */
/* -------------------------------------------------------------------------- */

/** `users` 行（`phone` 为密文，由路由层解密后脱敏下发）。 */
export interface ShopUserRow {
  readonly id: string;
  readonly nickname: string | null;
  readonly avatar_url: string | null;
  readonly status: string;
  /** AES-GCM 密文（`v1.<iv>.<cipher>`）。 */
  readonly phone: string;
}

/** `user_addresses` 行（`receiver_phone` 为密文，由路由层解密）。 */
export interface ShopAddressRow {
  readonly id: string;
  readonly receiver_name: string;
  readonly receiver_phone: string;
  readonly province: string;
  readonly city: string;
  readonly district: string;
  readonly detail: string;
  readonly is_default: number;
}

/* -------------------------------------------------------------------------- */
/* users                                                                        */
/* -------------------------------------------------------------------------- */

const USER_COLUMNS = "id, nickname, avatar_url, status, phone";

/** 按手机号哈希查用户（查不到返回 `null`）。 */
export async function findShopUserByPhoneHash(
  db: D1Database,
  phoneHash: string,
): Promise<ShopUserRow | null> {
  return await db
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE phone_hash = ? LIMIT 1`)
    .bind(phoneHash)
    .first<ShopUserRow>();
}

/** 按 id 查用户（`GET /shop/auth/me` 用）。 */
export async function findShopUserById(
  db: D1Database,
  userId: string,
): Promise<ShopUserRow | null> {
  return await db
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ? LIMIT 1`)
    .bind(userId)
    .first<ShopUserRow>();
}

/**
 * 建号（首次验证码登录）。
 *
 * `phone` 加密存储；`phone_hash` 供等值查询。两者都由调用方传入已算好的值，
 * 本函数不做密钥派生——密钥来自 `env`，属路由层职责。
 */
export async function insertShopUser(
  db: D1Database,
  input: {
    readonly id: string;
    readonly phoneEncrypted: string;
    readonly phoneHash: string;
    readonly nowIso: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO users (id, phone, phone_hash, nickname, avatar_url, status,
                          wechat_openid, wechat_unionid, created_at, updated_at)
       VALUES (?, ?, ?, NULL, NULL, ?, NULL, NULL, ?, ?)`,
    )
    .bind(
      input.id,
      input.phoneEncrypted,
      input.phoneHash,
      USER_STATUS.ACTIVE,
      input.nowIso,
      input.nowIso,
    )
    .run();
}

/**
 * 「按手机号哈希取用户，无则建号」——C 端登录的单一入口。
 *
 * ⚠️ 并发首登可能触发 `uq_users_phone_hash` 唯一冲突：捕获后**重查一次**即可，
 * 不引入额外锁（D1 无交互式事务，`docs/05` §5.3②）。
 */
export async function findOrCreateShopUserByPhone(
  db: D1Database,
  input: {
    readonly phone: string;
    readonly phoneHash: string;
    readonly phoneEncKey: string;
    readonly newUserId: string;
    readonly nowIso: string;
  },
): Promise<ShopUserRow> {
  const existing = await findShopUserByPhoneHash(db, input.phoneHash);
  if (existing !== null) return existing;

  const phoneEncrypted = await encryptPii(input.phoneEncKey, input.phone);
  try {
    await insertShopUser(db, {
      id: input.newUserId,
      phoneEncrypted,
      phoneHash: input.phoneHash,
      nowIso: input.nowIso,
    });
  } catch {
    // 唯一冲突（并发首登）：重查即可，绝不再插
    const retried = await findShopUserByPhoneHash(db, input.phoneHash);
    if (retried !== null) return retried;
    throw new Error("建号失败：phone_hash 冲突后重查仍为空");
  }

  const created = await findShopUserByPhoneHash(db, input.phoneHash);
  if (created === null) throw new Error("建号失败：插入后查不到该用户");
  return created;
}

/**
 * 规范化手机号并算检索哈希；手机号非法返回 `null`。
 *
 * 供 `/shop/auth/sms-code` 与 `/shop/auth/login` 共用，避免两处规范化口径漂移。
 */
export async function phoneHashOf(
  phone: string,
  pepper: string,
): Promise<{ normalized: string; phoneHash: string } | null> {
  const normalized = normalizePhone(phone);
  if (normalized === null) return null;
  return { normalized, phoneHash: await hashPhone(pepper, normalized) };
}

/** 解密 `users.phone`；非密文（历史脏数据）原样返回，**不抛**。 */
export async function decryptUserPhone(phoneEncKey: string, stored: string): Promise<string> {
  const plain = await decryptPii(phoneEncKey, stored);
  return plain ?? stored;
}

/* -------------------------------------------------------------------------- */
/* user_addresses                                                               */
/* -------------------------------------------------------------------------- */

const ADDRESS_COLUMNS =
  "id, receiver_name, receiver_phone, province, city, district, detail, is_default";

/**
 * 列出该用户启用中的收货地址（默认地址置顶）。
 *
 * 排序用 `is_default DESC, created_at DESC`（`docs/03` §3.5.1 的地址簿展示）。
 */
export async function listShopAddresses(db: D1Database, userId: string): Promise<ShopAddressRow[]> {
  const res = await db
    .prepare(
      `SELECT ${ADDRESS_COLUMNS}
         FROM user_addresses
        WHERE user_id = ? AND status = 'active'
        ORDER BY is_default DESC, created_at DESC`,
    )
    .bind(userId)
    .all<ShopAddressRow>();
  return res.results;
}

/** 取单个地址（带归属校验：`user_id` 不匹配即视为不存在）。 */
export async function findShopAddress(
  db: D1Database,
  userId: string,
  addressId: string,
): Promise<ShopAddressRow | null> {
  return await db
    .prepare(
      `SELECT ${ADDRESS_COLUMNS}
         FROM user_addresses
        WHERE id = ? AND user_id = ? AND status = 'active'
        LIMIT 1`,
    )
    .bind(addressId, userId)
    .first<ShopAddressRow>();
}

/**
 * 解密收货手机号。
 *
 * 历史脏数据可能未加密（明文直存），此时 `decryptPii` 返回 `null`——
 * 按「原文即明文」兜底返回，**不抛**（避免一条脏数据让整个地址簿 500）。
 */
export async function decryptReceiverPhone(phoneEncKey: string, stored: string): Promise<string> {
  const plain = await decryptPii(phoneEncKey, stored);
  return plain ?? stored;
}

/* -------------------------------------------------------------------------- */
/* 短信验证码（`docs/08` §8.1）                                                 */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ **schema 缺口（如实登记，未臆造表）**：
 * 41 张表里**没有**验证码表（`sms_codes` / `verification_codes` 均不存在），
 * `docs/05` §5.2 也未定义。故本实现把验证码**暂存**在既有的 `settings` 表
 * （主键 `key`，另有 `value` / `description` / `updated_at`），键名带
 * `shop_sms_code:` 前缀以免与平台参数混淆。
 *
 * 这不是终态：正确做法是新增专用表（含 `phone_hash`、`code_hash`、`expires_at`、
 * `attempts` 四列）。本文件把读写都收敛在下面三个函数里，
 * **换表时只需改这里**，路由层零改动。
 */

/** 验证码在 `settings` 表中的键前缀。 */
export const SMS_CODE_KEY_PREFIX = "shop_sms_code:";

/** 验证码有效期（秒）——`docs/08` §8.1 未定义，实现侧定案 5 分钟。 */
export const SMS_CODE_TTL_SECONDS = 300;

/** 验证码发送冷却（秒）——`docs/08` §8.1 明确「60s 冷却」。 */
export const SMS_CODE_COOLDOWN_SECONDS = 60;

/** 验证码载荷（存 `settings.value` 的 JSON）。 */
export interface ShopSmsCodeRecord {
  /** `SHA-256(验证码)` hex（**不存明文**）。 */
  readonly codeHash: string;
  /** 发送时刻（毫秒）。 */
  readonly sentAtMs: number;
  /** 过期时刻（毫秒）。 */
  readonly expiresAtMs: number;
}

/** 读验证码记录；无记录或 JSON 损坏返回 `null`。 */
export async function readShopSmsCode(
  db: D1Database,
  phoneHash: string,
): Promise<ShopSmsCodeRecord | null> {
  const row = await db
    .prepare("SELECT value FROM settings WHERE key = ? LIMIT 1")
    .bind(`${SMS_CODE_KEY_PREFIX}${phoneHash}`)
    .first<{ value: string }>();
  if (row === null) return null;
  try {
    const parsed: unknown = JSON.parse(row.value);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.codeHash !== "string") return null;
    if (typeof record.sentAtMs !== "number" || typeof record.expiresAtMs !== "number") {
      return null;
    }
    return {
      codeHash: record.codeHash,
      sentAtMs: record.sentAtMs,
      expiresAtMs: record.expiresAtMs,
    };
  } catch {
    return null;
  }
}

/** 写（覆盖）验证码记录。 */
export async function writeShopSmsCode(
  db: D1Database,
  phoneHash: string,
  record: ShopSmsCodeRecord,
  nowIso: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (key, value, description, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(
      `${SMS_CODE_KEY_PREFIX}${phoneHash}`,
      JSON.stringify(record),
      "C 端短信验证码（临时存放，待专用表落地）",
      nowIso,
    )
    .run();
}

/** 删除验证码记录（校验成功后**一次性作废**）。 */
export async function deleteShopSmsCode(db: D1Database, phoneHash: string): Promise<void> {
  await db
    .prepare("DELETE FROM settings WHERE key = ?")
    .bind(`${SMS_CODE_KEY_PREFIX}${phoneHash}`)
    .run();
}
