-- DShop M0 基础种子（**非**虚构业务数据）
--
-- 内容（docs/M0-字段契约.md §11）：
--   1) roles：8 行内置角色，code/scope/name 取契约 §11 表格；
--      permissions 取 @dshop/shared `ROLE_PERMISSIONS` 的权限点数组（逐字照录 packages/shared/src/rbac.ts）
--   2) settings：agent_require_signature = false（docs/07 §7.8.1 默认关闭）
--
-- **不插入 admin_users**：超管密码哈希由 scripts/build-seed-sql.ts 用 @dshop/auth 的 hashPassword 现场派生。
-- 幂等：全部 INSERT ... ON CONFLICT(...) DO UPDATE SET ...，可重复执行。
-- 角色 id 为固定可读的 26 位 ULID 风格常量（Crocksford Base32 字符集，排除 I/L/O/U）。

-- ---------------------------------------------------------------------------
-- roles（8 行）
-- ROLE_PERMISSIONS 逐字来源：packages/shared/src/rbac.ts
--   platform_super_admin = ALL_PERMISSIONS（7 个权限点，顺序同 PERMISSIONS 声明）
--   platform_operator    = [product:review, merchant:approve, aftersale:policy:manage]
--   platform_finance     = [settlement:confirm]
--   platform_support     = [aftersale:approve]
--   merchant_admin       = [order:ship, aftersale:approve]
--   merchant_staff       = [order:ship, aftersale:approve]
--   customer             = ROLE_PERMISSIONS 中无此 code（RBAC 矩阵仅 6 个 code）→ []
--   agent_service        = ROLE_PERMISSIONS 中无此 code；身份由 service_tokens.scopes 承载，
--                          此处落 @dshop/shared `AGENT_SERVICE_IDENTITY.scopes` 的 4 个读 scope
--                          （packages/shared/src/rbac.ts L90–L93）
-- ---------------------------------------------------------------------------

INSERT INTO roles (id, scope, code, name, permissions, created_at, updated_at) VALUES
  ('01J0000000000000000000R01', 'platform', 'platform_super_admin', '平台超管',
   '["merchant:approve","product:review","order:ship","aftersale:approve","settlement:confirm","agent:token:manage","aftersale:policy:manage"]',
   '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
ON CONFLICT(code) DO UPDATE SET
  scope = excluded.scope,
  name = excluded.name,
  permissions = excluded.permissions,
  updated_at = excluded.updated_at;

INSERT INTO roles (id, scope, code, name, permissions, created_at, updated_at) VALUES
  ('01J0000000000000000000R02', 'platform', 'platform_operator', '平台运营',
   '["product:review","merchant:approve","aftersale:policy:manage"]',
   '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
ON CONFLICT(code) DO UPDATE SET
  scope = excluded.scope,
  name = excluded.name,
  permissions = excluded.permissions,
  updated_at = excluded.updated_at;

INSERT INTO roles (id, scope, code, name, permissions, created_at, updated_at) VALUES
  ('01J0000000000000000000R03', 'platform', 'platform_finance', '平台财务',
   '["settlement:confirm"]',
   '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
ON CONFLICT(code) DO UPDATE SET
  scope = excluded.scope,
  name = excluded.name,
  permissions = excluded.permissions,
  updated_at = excluded.updated_at;

INSERT INTO roles (id, scope, code, name, permissions, created_at, updated_at) VALUES
  ('01J0000000000000000000R04', 'platform', 'platform_support', '平台客服',
   '["aftersale:approve"]',
   '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
ON CONFLICT(code) DO UPDATE SET
  scope = excluded.scope,
  name = excluded.name,
  permissions = excluded.permissions,
  updated_at = excluded.updated_at;

INSERT INTO roles (id, scope, code, name, permissions, created_at, updated_at) VALUES
  ('01J0000000000000000000R05', 'merchant', 'merchant_admin', '商户管理员',
   '["order:ship","aftersale:approve"]',
   '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
ON CONFLICT(code) DO UPDATE SET
  scope = excluded.scope,
  name = excluded.name,
  permissions = excluded.permissions,
  updated_at = excluded.updated_at;

INSERT INTO roles (id, scope, code, name, permissions, created_at, updated_at) VALUES
  ('01J0000000000000000000R06', 'merchant', 'merchant_staff', '商户店员',
   '["order:ship","aftersale:approve"]',
   '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
ON CONFLICT(code) DO UPDATE SET
  scope = excluded.scope,
  name = excluded.name,
  permissions = excluded.permissions,
  updated_at = excluded.updated_at;

INSERT INTO roles (id, scope, code, name, permissions, created_at, updated_at) VALUES
  ('01J0000000000000000000R07', 'platform', 'customer', '顾客',
   '[]',
   '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
ON CONFLICT(code) DO UPDATE SET
  scope = excluded.scope,
  name = excluded.name,
  permissions = excluded.permissions,
  updated_at = excluded.updated_at;

INSERT INTO roles (id, scope, code, name, permissions, created_at, updated_at) VALUES
  ('01J0000000000000000000R08', 'platform', 'agent_service', 'PiEcho Agent 服务身份',
   '["agent:order:read","agent:product:read","agent:aftersale:read","agent:policy:read"]',
   '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
ON CONFLICT(code) DO UPDATE SET
  scope = excluded.scope,
  name = excluded.name,
  permissions = excluded.permissions,
  updated_at = excluded.updated_at;

-- ---------------------------------------------------------------------------
-- settings
-- ---------------------------------------------------------------------------

INSERT INTO settings (key, value, description, updated_at) VALUES
  ('agent_require_signature', 'false', 'Agent 请求体签名校验开关（docs/07 §7.8.1 默认关闭）',
   '2026-01-01T00:00:00.000Z')
ON CONFLICT(key) DO UPDATE SET
  value = excluded.value,
  description = excluded.description,
  updated_at = excluded.updated_at;
