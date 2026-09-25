-- DShop M0 初始化：41 张表，列名基准 docs/M0-字段契约.md
--
-- 全局约定（契约 §0）：
--   主键 id TEXT PRIMARY KEY（ULID 26 位）；金额 INTEGER（分）；比例 INTEGER（万分比）
--   时间 TEXT ISO-8601 UTC；布尔 INTEGER 0/1；JSON TEXT
--   **不声明 SQL 级 FOREIGN KEY**，由应用层保证；索引照建
-- 每条 DDL 均为 IF NOT EXISTS，可重复执行。
-- 单号正则（@dshop/shared ids.ts）：DS\d{17} / DS\d{17}-\d{2} / AS\d{11} / PAY\d{17} / RF\d{17}

-- ===========================================================================
-- 1. 会员域（3）
-- ===========================================================================

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  phone           TEXT NOT NULL,
  phone_hash      TEXT NOT NULL,
  nickname        TEXT,
  avatar_url      TEXT,
  status          TEXT NOT NULL DEFAULT 'active',
  wechat_openid   TEXT,
  wechat_unionid  TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_phone ON users(phone);
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_phone_hash ON users(phone_hash);

CREATE TABLE IF NOT EXISTS user_addresses (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  receiver_name   TEXT NOT NULL,
  receiver_phone  TEXT NOT NULL,
  province        TEXT NOT NULL,
  city            TEXT NOT NULL,
  district        TEXT NOT NULL,
  detail          TEXT NOT NULL,
  postal_code     TEXT,
  is_default      INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_addresses_user ON user_addresses(user_id, is_default DESC);

CREATE TABLE IF NOT EXISTS user_favorites (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  spu_id      TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_favorites ON user_favorites(user_id, spu_id);

-- ===========================================================================
-- 2. 账号域（7）
-- ===========================================================================

CREATE TABLE IF NOT EXISTS admin_users (
  id               TEXT PRIMARY KEY,
  username         TEXT NOT NULL,
  password_hash    TEXT NOT NULL,
  nickname         TEXT,
  status           TEXT NOT NULL DEFAULT 'active',
  totp_secret      TEXT,
  totp_enabled     INTEGER NOT NULL DEFAULT 0,
  last_login_at    TEXT,
  failed_attempts  INTEGER NOT NULL DEFAULT 0,
  locked_until     TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_admin_users_username ON admin_users(username);

CREATE TABLE IF NOT EXISTS roles (
  id           TEXT PRIMARY KEY,
  scope        TEXT NOT NULL,
  code         TEXT NOT NULL,
  name         TEXT NOT NULL,
  permissions  TEXT NOT NULL DEFAULT '[]',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_roles_code ON roles(code);

CREATE TABLE IF NOT EXISTS admin_user_roles (
  id             TEXT PRIMARY KEY,
  admin_user_id  TEXT NOT NULL,
  role_id        TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_admin_user_roles ON admin_user_roles(admin_user_id, role_id);

CREATE TABLE IF NOT EXISTS merchant_members (
  id             TEXT PRIMARY KEY,
  merchant_id    TEXT NOT NULL,
  admin_user_id  TEXT NOT NULL,
  role           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_merchant_members ON merchant_members(merchant_id, admin_user_id);
CREATE INDEX IF NOT EXISTS idx_merchant_members_admin ON merchant_members(admin_user_id);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id            TEXT PRIMARY KEY,
  subject_type  TEXT NOT NULL,
  subject_id    TEXT NOT NULL,
  token_hash    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT,
  replaced_by   TEXT,
  user_agent    TEXT,
  ip            TEXT,
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_refresh_tokens_hash ON refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_subject ON refresh_tokens(subject_type, subject_id);

CREATE TABLE IF NOT EXISTS service_tokens (
  id                  TEXT PRIMARY KEY,
  token_hash          TEXT NOT NULL,
  token_prefix        TEXT NOT NULL,
  name                TEXT NOT NULL,
  scopes              TEXT NOT NULL DEFAULT '[]',
  status              TEXT NOT NULL DEFAULT 'active',
  expires_at          TEXT NOT NULL,
  last_used_at        TEXT,
  rate_limit_per_min  INTEGER NOT NULL DEFAULT 600,
  created_by          TEXT NOT NULL,
  revoked_at          TEXT,
  revoked_by          TEXT,
  rotated_from        TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_service_tokens_hash ON service_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_service_tokens_prefix ON service_tokens(token_prefix);

CREATE TABLE IF NOT EXISTS audit_logs (
  id           TEXT PRIMARY KEY,
  actor_type   TEXT NOT NULL,
  actor_id     TEXT,
  action       TEXT NOT NULL,
  target_type  TEXT,
  target_id    TEXT,
  before       TEXT,
  after        TEXT,
  ip           TEXT,
  user_agent   TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_type, actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target ON audit_logs(target_type, target_id);

-- ===========================================================================
-- 3. 商户域（3）
-- ===========================================================================

CREATE TABLE IF NOT EXISTS merchants (
  id                  TEXT PRIMARY KEY,
  type                TEXT NOT NULL,
  name                TEXT NOT NULL,
  logo_url            TEXT,
  contact_name        TEXT,
  contact_phone       TEXT,
  qualification_urls  TEXT NOT NULL DEFAULT '[]',
  status              TEXT NOT NULL DEFAULT 'pending',
  commission_rate_bp  INTEGER NOT NULL DEFAULT 0,
  settlement_account  TEXT NOT NULL DEFAULT '{}',
  description         TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_merchants_status ON merchants(status);

CREATE TABLE IF NOT EXISTS stores (
  id               TEXT PRIMARY KEY,
  merchant_id      TEXT NOT NULL,
  name             TEXT NOT NULL,
  type             TEXT NOT NULL,
  longitude        REAL,
  latitude         REAL,
  province         TEXT,
  city             TEXT,
  district         TEXT,
  address          TEXT,
  business_hours   TEXT NOT NULL DEFAULT '{}',
  supports_pickup  INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'active',
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stores_merchant ON stores(merchant_id, status);

CREATE TABLE IF NOT EXISTS store_stocks (
  id            TEXT PRIMARY KEY,
  store_id      TEXT NOT NULL,
  sku_id        TEXT NOT NULL,
  stock         INTEGER NOT NULL DEFAULT 0,
  locked_stock  INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_store_stocks ON store_stocks(store_id, sku_id);

-- ===========================================================================
-- 4. 商品域（5）
-- ===========================================================================

CREATE TABLE IF NOT EXISTS categories (
  id          TEXT PRIMARY KEY,
  parent_id   TEXT,
  name        TEXT NOT NULL,
  slug        TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id, sort_order);

CREATE TABLE IF NOT EXISTS products (
  id             TEXT PRIMARY KEY,
  merchant_id    TEXT NOT NULL,
  category_id    TEXT NOT NULL,
  category_path  TEXT NOT NULL DEFAULT '[]',
  title          TEXT NOT NULL,
  subtitle       TEXT,
  main_image     TEXT,
  detail_html    TEXT,
  brand          TEXT,
  status         TEXT NOT NULL DEFAULT 'draft',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_merchant ON products(merchant_id, status);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id, status);

CREATE TABLE IF NOT EXISTS product_skus (
  id            TEXT PRIMARY KEY,
  product_id    TEXT NOT NULL,
  spec          TEXT NOT NULL DEFAULT '{}',
  sku_code      TEXT NOT NULL,
  price         INTEGER NOT NULL,
  market_price  INTEGER,
  stock         INTEGER NOT NULL DEFAULT 0,
  locked_stock  INTEGER NOT NULL DEFAULT 0,
  restock_eta   TEXT,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skus_product ON product_skus(product_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_skus_code ON product_skus(sku_code);

CREATE TABLE IF NOT EXISTS product_attrs (
  id           TEXT PRIMARY KEY,
  spu_id       TEXT NOT NULL,
  group_name   TEXT NOT NULL,
  attr_name    TEXT NOT NULL,
  attr_value   TEXT NOT NULL,
  unit         TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  searchable   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_product_attrs_spu ON product_attrs(spu_id, group_name, sort_order);

CREATE TABLE IF NOT EXISTS product_images (
  id          TEXT PRIMARY KEY,
  product_id  TEXT NOT NULL,
  url         TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_product_images_product ON product_images(product_id, sort_order);

-- ===========================================================================
-- 5. 交易域（8）
-- ===========================================================================

CREATE TABLE IF NOT EXISTS cart_items (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  sku_id      TEXT NOT NULL,
  quantity    INTEGER NOT NULL,
  selected    INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cart_items ON cart_items(user_id, sku_id);

CREATE TABLE IF NOT EXISTS orders (
  id                TEXT PRIMARY KEY,
  order_no          TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  status            TEXT NOT NULL,
  total_amount      INTEGER NOT NULL,
  discount_amount   INTEGER NOT NULL DEFAULT 0,
  freight_amount    INTEGER NOT NULL DEFAULT 0,
  pay_amount        INTEGER NOT NULL,
  address_snapshot  TEXT NOT NULL,
  coupon_id         TEXT,
  channel           TEXT NOT NULL,
  pay_deadline      TEXT,
  paid_at           TEXT,
  completed_at      TEXT,
  cancelled_at      TEXT,
  remark            TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_no ON orders(order_no);
CREATE INDEX IF NOT EXISTS idx_orders_user_time ON orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at DESC);

CREATE TABLE IF NOT EXISTS sub_orders (
  id                   TEXT PRIMARY KEY,
  sub_order_no         TEXT NOT NULL,
  order_id             TEXT NOT NULL,
  merchant_id          TEXT NOT NULL,
  store_id             TEXT NOT NULL,
  status               TEXT NOT NULL,
  subtotal             INTEGER NOT NULL,
  discount_alloc       INTEGER NOT NULL DEFAULT 0,
  freight              INTEGER NOT NULL DEFAULT 0,
  commission_amount    INTEGER NOT NULL DEFAULT 0,
  express_company      TEXT,
  express_company_code TEXT,
  express_no           TEXT,
  shipped_at           TEXT,
  received_at          TEXT,
  settled              INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sub_orders_no ON sub_orders(sub_order_no);
CREATE INDEX IF NOT EXISTS idx_sub_orders_order ON sub_orders(order_id);
CREATE INDEX IF NOT EXISTS idx_sub_orders_merchant ON sub_orders(merchant_id, status);

CREATE TABLE IF NOT EXISTS order_items (
  id            TEXT PRIMARY KEY,
  sub_order_id  TEXT NOT NULL,
  order_id      TEXT NOT NULL,
  spu_id        TEXT NOT NULL,
  sku_id        TEXT NOT NULL,
  title         TEXT NOT NULL,
  image         TEXT,
  spec          TEXT NOT NULL DEFAULT '{}',
  unit_price    INTEGER NOT NULL,
  quantity      INTEGER NOT NULL,
  subtotal      INTEGER NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_items_sub ON order_items(sub_order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_sku ON order_items(sku_id);

CREATE TABLE IF NOT EXISTS order_status_logs (
  id            TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL,
  sub_order_id  TEXT,
  kind          TEXT NOT NULL DEFAULT 'status',
  from_status   TEXT,
  to_status     TEXT NOT NULL,
  actor_type    TEXT NOT NULL,
  actor_id      TEXT,
  remark        TEXT,
  occurred_at   TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_status_logs_order ON order_status_logs(order_id, created_at);
CREATE INDEX IF NOT EXISTS idx_order_status_logs_sub ON order_status_logs(sub_order_id, occurred_at);

CREATE TABLE IF NOT EXISTS payments (
  id                TEXT PRIMARY KEY,
  pay_no            TEXT NOT NULL,
  order_id          TEXT NOT NULL,
  channel           TEXT NOT NULL,
  channel_trade_no  TEXT NOT NULL,
  amount            INTEGER NOT NULL,
  status            TEXT NOT NULL,
  paid_at           TEXT,
  raw_callback      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_no ON payments(pay_no);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_trade_no ON payments(channel_trade_no);

CREATE TABLE IF NOT EXISTS refunds (
  id                      TEXT PRIMARY KEY,
  refund_no               TEXT NOT NULL,
  aftersale_id            TEXT,
  order_id                TEXT NOT NULL,
  amount                  INTEGER NOT NULL,
  channel                 TEXT,
  status                  TEXT NOT NULL,
  channel_refund_no       TEXT,
  arrived_at              TEXT,
  estimated_arrival_days  INTEGER,
  raw_callback            TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_refunds_no ON refunds(refund_no);
CREATE INDEX IF NOT EXISTS idx_refunds_aftersale ON refunds(aftersale_id);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id             TEXT PRIMARY KEY,
  scope          TEXT NOT NULL,
  key            TEXT NOT NULL,
  request_hash   TEXT,
  response_body  TEXT,
  status         TEXT NOT NULL DEFAULT 'processing',
  expires_at     TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_idempotency_keys ON idempotency_keys(scope, key);

-- ===========================================================================
-- 6. 售后域（3）
-- ===========================================================================

CREATE TABLE IF NOT EXISTS aftersales (
  id                      TEXT PRIMARY KEY,
  aftersale_no            TEXT NOT NULL,
  order_id                TEXT NOT NULL,
  sub_order_id            TEXT NOT NULL,
  user_id                 TEXT NOT NULL,
  sku_id                  TEXT NOT NULL,
  item_title              TEXT NOT NULL,
  quantity                INTEGER NOT NULL DEFAULT 1,
  type                    TEXT NOT NULL,
  status                  TEXT NOT NULL,
  reason                  TEXT,
  evidence_urls           TEXT NOT NULL DEFAULT '[]',
  refund_amount           INTEGER NOT NULL DEFAULT 0,
  return_address          TEXT,
  return_express_company  TEXT,
  return_express_no       TEXT,
  deadline_at             TEXT,
  applied_at              TEXT,
  refunded_at             TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_aftersales_no ON aftersales(aftersale_no);
CREATE INDEX IF NOT EXISTS idx_aftersales_sub ON aftersales(sub_order_id);
CREATE INDEX IF NOT EXISTS idx_aftersales_user ON aftersales(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS aftersale_logs (
  id            TEXT PRIMARY KEY,
  aftersale_id  TEXT NOT NULL,
  from_status   TEXT,
  to_status     TEXT NOT NULL,
  actor_type    TEXT NOT NULL,
  actor_id      TEXT,
  remark        TEXT,
  occurred_at   TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aftersale_logs_aftersale ON aftersale_logs(aftersale_id, occurred_at);

CREATE TABLE IF NOT EXISTS aftersale_policies (
  id              TEXT PRIMARY KEY,
  category        TEXT NOT NULL,
  title           TEXT NOT NULL,
  content         TEXT NOT NULL,
  version         TEXT NOT NULL,
  effective_from  TEXT NOT NULL,
  effective_to    TEXT,
  status          TEXT NOT NULL DEFAULT 'draft',
  tags            TEXT NOT NULL DEFAULT '[]',
  created_by      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aftersale_policies_category ON aftersale_policies(category, status, effective_from DESC);

-- ===========================================================================
-- 7. 营销域（4）
-- ===========================================================================

CREATE TABLE IF NOT EXISTS coupon_templates (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  type              TEXT NOT NULL,
  discount_amount   INTEGER NOT NULL DEFAULT 0,
  threshold_amount  INTEGER NOT NULL DEFAULT 0,
  discount_bp       INTEGER NOT NULL DEFAULT 0,
  total_quantity    INTEGER NOT NULL DEFAULT 0,
  issued_quantity   INTEGER NOT NULL DEFAULT 0,
  per_user_limit    INTEGER NOT NULL DEFAULT 1,
  valid_from        TEXT,
  valid_to          TEXT,
  status            TEXT NOT NULL DEFAULT 'active',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_coupons (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  template_id  TEXT NOT NULL,
  code         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'unused',
  used_at      TEXT,
  order_id     TEXT,
  expires_at   TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_coupons_code ON user_coupons(code);
CREATE INDEX IF NOT EXISTS idx_user_coupons_user ON user_coupons(user_id, status);

CREATE TABLE IF NOT EXISTS freight_templates (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,
  rules       TEXT NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS promotions (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,
  rules       TEXT NOT NULL DEFAULT '{}',
  start_at    TEXT NOT NULL,
  end_at      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'draft',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- ===========================================================================
-- 8. 内容域（3）
-- ===========================================================================

CREATE TABLE IF NOT EXISTS reviews (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  spu_id         TEXT NOT NULL,
  sku_id         TEXT,
  order_item_id  TEXT,
  rating         INTEGER NOT NULL DEFAULT 5,
  content        TEXT,
  images         TEXT NOT NULL DEFAULT '[]',
  status         TEXT NOT NULL DEFAULT 'pending',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reviews_spu ON reviews(spu_id, status);

CREATE TABLE IF NOT EXISTS content_blocks (
  id          TEXT PRIMARY KEY,
  position    TEXT NOT NULL,
  title       TEXT,
  image_url   TEXT,
  link_url    TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cms_pages (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL,
  title       TEXT NOT NULL,
  content     TEXT,
  status      TEXT NOT NULL DEFAULT 'draft',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cms_pages_slug ON cms_pages(slug);

-- ===========================================================================
-- 9. 结算域（2）
-- ===========================================================================

CREATE TABLE IF NOT EXISTS settlements (
  id                 TEXT PRIMARY KEY,
  merchant_id        TEXT NOT NULL,
  period_start       TEXT NOT NULL,
  period_end         TEXT NOT NULL,
  order_count        INTEGER NOT NULL DEFAULT 0,
  gross_amount       INTEGER NOT NULL DEFAULT 0,
  commission_amount  INTEGER NOT NULL DEFAULT 0,
  net_amount         INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'pending',
  confirmed_at       TEXT,
  paid_at            TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_settlements_merchant ON settlements(merchant_id, status);

CREATE TABLE IF NOT EXISTS settlement_items (
  id                 TEXT PRIMARY KEY,
  settlement_id      TEXT NOT NULL,
  sub_order_id       TEXT NOT NULL,
  amount             INTEGER NOT NULL DEFAULT 0,
  commission_amount  INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL
);

-- ===========================================================================
-- 10. 支撑域（3）
-- ===========================================================================

CREATE TABLE IF NOT EXISTS task_queue (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  payload     TEXT NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'pending',
  attempts    INTEGER NOT NULL DEFAULT 0,
  run_at      TEXT NOT NULL,
  last_error  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_queue_status ON task_queue(status, run_at);

CREATE TABLE IF NOT EXISTS settings (
  key          TEXT PRIMARY KEY,
  value        TEXT NOT NULL,
  description  TEXT,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_call_logs (
  id                TEXT PRIMARY KEY,
  token_id          TEXT NOT NULL,
  path              TEXT NOT NULL,
  method            TEXT NOT NULL DEFAULT 'GET',
  params_hash       TEXT,
  status            INTEGER NOT NULL,
  duration_ms       INTEGER NOT NULL DEFAULT 0,
  cache_hit         INTEGER NOT NULL DEFAULT 0,
  contract_version  TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_logs_token_time ON agent_call_logs(token_id, created_at DESC);

-- ===========================================================================
-- 自检清单：41 张表（与 docs/M0-字段契约.md §1–§10 一一对应）
-- ===========================================================================
-- 会员（3）：users、user_addresses、user_favorites
-- 账号（7）：admin_users、roles、admin_user_roles、merchant_members、refresh_tokens、service_tokens、audit_logs
-- 商户（3）：merchants、stores、store_stocks
-- 商品（5）：categories、products、product_skus、product_attrs、product_images
-- 交易（8）：cart_items、orders、sub_orders、order_items、order_status_logs、payments、refunds、idempotency_keys
-- 售后（3）：aftersales、aftersale_logs、aftersale_policies
-- 营销（4）：coupon_templates、user_coupons、freight_templates、promotions
-- 内容（3）：reviews、content_blocks、cms_pages
-- 结算（2）：settlements、settlement_items
-- 支撑（3）：task_queue、settings、agent_call_logs
-- 合计：3+7+3+5+8+3+4+3+2+3 = 41
