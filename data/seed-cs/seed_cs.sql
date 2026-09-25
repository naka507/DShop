-- =============================================================================
-- DShop seed-cs —— 虚构客服场景数据集（dev/staging 专用）
--
-- ⚠️ 本文件是**虚构的客服场景数据集**，仅供开发与验收使用。
--    依据 Q6 决策（M0 允许使用虚构场景数据，见 docs/10 §12.3），
--    生产环境**不得**导入本文件中的任何订单/售后/会员数据。
--
-- 生成来源：scripts/build-seed-sql.ts（数据来源 data/seed-cs/{products,product_attrs,
--   aftersale_policies,orders,aftersales,users}.json；merchants/stores/categories 为脚本内常量）
-- 列名基准：docs/M0-字段契约.md（snake_case，唯一基准）
-- 幂等：全部语句均为 INSERT ... ON CONFLICT(<唯一键>) DO UPDATE SET，可重复执行。
-- 冲突键：docs/M0-字段契约.md §12。
--
-- 时区：时间字段一律 UTC ISO-8601；单号内嵌时间戳一律 UTC+8。
--   DS20260920143000123 ⇔ 2026-09-20T06:30:00.000Z
--
-- users.phone / users.phone_hash：由 PHONE_ENC_KEY / PHONE_HASH_PEPPER **现场派生**
--   （phone = AES-256-GCM(PHONE_ENC_KEY, 明文)，phone_hash = HMAC-SHA256(PHONE_HASH_PEPPER, 明文)）。
-- ⚠️ 本次生成使用了**开发默认密钥**（PHONE_ENC_KEY / PHONE_HASH_PEPPER 未设置）：
--    PHONE_ENC_KEY     = dshop-dev-phone-enc-key
--    PHONE_HASH_PEPPER = dshop-dev-phone-hash-pepper
--    生产环境必须设置真实密钥后重新生成，不得沿用本文件的派生值。
-- =============================================================================

PRAGMA foreign_keys = OFF;

-- 商户（merchants）：1 个自营

INSERT INTO merchants (id, type, name, logo_url, contact_name, contact_phone, qualification_urls, status, commission_rate_bp, settlement_account, description, created_at, updated_at) VALUES
  ('01J9Z8K2M4N5P6Q7R8S9T0V1M1', 'self', 'DShop 自营旗舰店', 'https://img.dshop.example.com/m/self-flag.svg', '自营客服中心', '057188880000', '["https://img.dshop.example.com/m/qualification/business-license.png"]', 'approved', 0, '{"bank":"招商银行","account":"****0000","holder":"DShop 自营"}', '平台自营主体，总部统管（Q4 形态 A）', '2026-01-05T02:00:00.000Z', '2026-06-01T02:00:00.000Z')
ON CONFLICT(id) DO UPDATE SET type = excluded.type, name = excluded.name, logo_url = excluded.logo_url, contact_name = excluded.contact_name, contact_phone = excluded.contact_phone, qualification_urls = excluded.qualification_urls, status = excluded.status, commission_rate_bp = excluded.commission_rate_bp, settlement_account = excluded.settlement_account, description = excluded.description, created_at = excluded.created_at, updated_at = excluded.updated_at;

-- 门店/仓库（stores）：杭州仓（warehouse）+ 杭州西湖自提店（store）

INSERT INTO stores (id, merchant_id, name, type, longitude, latitude, province, city, district, address, business_hours, supports_pickup, status, created_at, updated_at) VALUES
  ('01J9Z8K2M4N5P6Q7R8S9T0V1R1', '01J9Z8K2M4N5P6Q7R8S9T0V1M1', '杭州仓', 'warehouse', 120.0789, 30.2765, '浙江省', '杭州市', '西湖区', '三墩镇西园一路 8 号', '{"weekdays":"09:00-18:00","weekend":"10:00-17:00"}', 0, 'active', '2026-01-05T02:00:00.000Z', '2026-06-01T02:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0V1R2', '01J9Z8K2M4N5P6Q7R8S9T0V1M1', '杭州西湖自提店', 'store', 120.1312, 30.2598, '浙江省', '杭州市', '西湖区', '文三路 478 号华星时代广场 1 层', '{"weekdays":"10:00-21:00","weekend":"10:00-22:00"}', 1, 'active', '2026-02-10T02:00:00.000Z', '2026-06-01T02:00:00.000Z')
ON CONFLICT(id) DO UPDATE SET merchant_id = excluded.merchant_id, name = excluded.name, type = excluded.type, longitude = excluded.longitude, latitude = excluded.latitude, province = excluded.province, city = excluded.city, district = excluded.district, address = excluded.address, business_hours = excluded.business_hours, supports_pickup = excluded.supports_pickup, status = excluded.status, created_at = excluded.created_at, updated_at = excluded.updated_at;

-- 类目（categories）：三级路径 数码→耳机→真无线耳机；数码→音箱→便携音箱

INSERT INTO categories (id, parent_id, name, slug, sort_order, status, created_at, updated_at) VALUES
  ('01J9Z8K2M4N5P6Q7R8S9T0V1C1', NULL, '数码', 'digital', 1, 'active', '2026-01-05T02:00:00.000Z', '2026-06-01T02:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0V1C2', '01J9Z8K2M4N5P6Q7R8S9T0V1C1', '耳机', 'headphone', 1, 'active', '2026-01-05T02:00:00.000Z', '2026-06-01T02:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0V1C3', '01J9Z8K2M4N5P6Q7R8S9T0V1C2', '真无线耳机', 'tws-earbuds', 1, 'active', '2026-01-05T02:00:00.000Z', '2026-06-01T02:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0V1C4', '01J9Z8K2M4N5P6Q7R8S9T0V1C1', '音箱', 'speaker', 2, 'active', '2026-01-05T02:00:00.000Z', '2026-06-01T02:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0V1C5', '01J9Z8K2M4N5P6Q7R8S9T0V1C4', '便携音箱', 'portable-speaker', 1, 'active', '2026-01-05T02:00:00.000Z', '2026-06-01T02:00:00.000Z')
ON CONFLICT(id) DO UPDATE SET parent_id = excluded.parent_id, name = excluded.name, slug = excluded.slug, sort_order = excluded.sort_order, status = excluded.status, created_at = excluded.created_at, updated_at = excluded.updated_at;

-- 商品（products）

INSERT INTO products (id, merchant_id, category_id, category_path, title, subtitle, main_image, detail_html, brand, status, created_at, updated_at) VALUES
  ('01J9Z8K2M4N5P6Q7R8S9T0V1W2', '01J9Z8K2M4N5P6Q7R8S9T0V1M1', '01J9Z8K2M4N5P6Q7R8S9T0V1C3', '["数码","耳机","真无线耳机"]', '极光 Pro 真无线降噪耳机', '45dB 深度降噪 · 综合续航 36 小时', 'https://img.dshop.example.com/p/aurora-buds-pro.jpg', '<h2>极光 Pro 真无线降噪耳机</h2><p>45dB 深度混合主动降噪，单次续航 8 小时，配充电仓综合续航 36 小时。</p><p><strong>重要提示：耳机本体防护等级为 IPX5（仅防日常出汗与轻度小雨泼溅），充电仓本体不具备防水能力（IPX0）。禁止佩戴游泳、潜水、泡温泉、淋浴或用水龙头直接冲洗；进液属人为损坏，不在保修范围。</strong></p>', '极光', 'onsale', '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0V1X1', '01J9Z8K2M4N5P6Q7R8S9T0V1M1', '01J9Z8K2M4N5P6Q7R8S9T0V1C5', '["数码","音箱","便携音箱"]', '极光 Lite 便携户外蓝牙音箱', 'IP67 防尘防水 · 续航 15 小时', 'https://img.dshop.example.com/p/aurora-sound-lite.jpg', '<h2>极光 Lite 便携户外蓝牙音箱</h2><p>双 10W 全频扬声器 + 双被动低音辐射板，4000mAh 电池连续播放约 15 小时。</p><p><strong>整机 IP67 防尘防水，支持 1 米深清水短时浸泡 30 分钟；但不可在海水、热水、温泉或化学液体中使用。</strong></p>', '极光', 'onsale', '2026-07-10T02:00:00.000Z', '2026-09-19T02:00:00.000Z')
ON CONFLICT(id) DO UPDATE SET merchant_id = excluded.merchant_id, category_id = excluded.category_id, category_path = excluded.category_path, title = excluded.title, subtitle = excluded.subtitle, main_image = excluded.main_image, detail_html = excluded.detail_html, brand = excluded.brand, status = excluded.status, created_at = excluded.created_at, updated_at = excluded.updated_at;

-- SKU（product_skus）—— 价格单位「分」；可售 = stock - locked_stock

INSERT INTO product_skus (id, product_id, spec, sku_code, price, market_price, stock, locked_stock, restock_eta, status, created_at, updated_at) VALUES
  ('01J9Z8K2M4N5P6Q7R8S9T0K001', '01J9Z8K2M4N5P6Q7R8S9T0V1W2', '{"颜色":"曜石黑","版本":"降噪版"}', 'ABP-BK-NC', 12900, 15900, 42, 2, NULL, 'active', '2026-06-01T02:00:00.000Z', '2026-09-21T02:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0K002', '01J9Z8K2M4N5P6Q7R8S9T0V1W2', '{"颜色":"冰晶白","版本":"降噪版"}', 'ABP-WH-NC', 12900, 15900, 0, 0, '2026-09-28', 'active', '2026-06-01T02:00:00.000Z', '2026-09-21T02:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0K003', '01J9Z8K2M4N5P6Q7R8S9T0V1X1', '{"颜色":"军绿色","版本":"标准版"}', 'ASL-GN-ST', 9900, 12900, 30, 0, NULL, 'active', '2026-07-10T02:00:00.000Z', '2026-09-19T02:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0K004', '01J9Z8K2M4N5P6Q7R8S9T0V1X1', '{"颜色":"曜石黑","版本":"标准版"}', 'ASL-BK-ST', 9900, 12900, 18, 0, NULL, 'active', '2026-07-10T02:00:00.000Z', '2026-09-19T02:00:00.000Z')
ON CONFLICT(sku_code) DO UPDATE SET id = excluded.id, product_id = excluded.product_id, spec = excluded.spec, price = excluded.price, market_price = excluded.market_price, stock = excluded.stock, locked_stock = excluded.locked_stock, restock_eta = excluded.restock_eta, status = excluded.status, created_at = excluded.created_at, updated_at = excluded.updated_at;

-- 商品参数（product_attrs）
--   分组：基本信息 / 技术参数 / 电池续航 / 连接方式 / 防护等级 / 售后与保修 / 包装清单
--   ⚠️ 场景③负面断言：全表不存在任何未录入的功能性参数（含各类生理监测功能）。
--   时间字段：JSON 未提供，沿用实现侧定案常量（见 scripts/README.md）。

INSERT INTO product_attrs (id, spu_id, group_name, attr_name, attr_value, unit, sort_order, searchable, created_at, updated_at) VALUES
  ('01J9Z8K2M4N5P6Q7R8S9T0A001', '01J9Z8K2M4N5P6Q7R8S9T0V1W2', '基本信息', '型号', 'Aurora-Buds-Pro', NULL, 1, 1, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0A002', '01J9Z8K2M4N5P6Q7R8S9T0V1W2', '基本信息', '佩戴方式', '真无线入耳式', NULL, 2, 1, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0A003', '01J9Z8K2M4N5P6Q7R8S9T0V1W2', '基本信息', '驱动单元', '11mm 动圈 + 复合陶瓷高音动铁双单元', NULL, 3, 0, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0A004', '01J9Z8K2M4N5P6Q7R8S9T0V1W2', '技术参数', '降噪深度', '45', 'dB', 4, 1, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0A005', '01J9Z8K2M4N5P6Q7R8S9T0V1W2', '技术参数', '蓝牙版本', '5.4', NULL, 5, 1, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0A006', '01J9Z8K2M4N5P6Q7R8S9T0V1W2', '技术参数', '单次续航', '8', '小时', 6, 1, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0A007', '01J9Z8K2M4N5P6Q7R8S9T0V1W2', '技术参数', '综合续航（含充电仓）', '36', '小时', 7, 1, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0A008', '01J9Z8K2M4N5P6Q7R8S9T0V1W2', '技术参数', '降噪档位', '轻度/深度/抗风噪三档自适应', NULL, 8, 0, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0A009', '01J9Z8K2M4N5P6Q7R8S9T0V1W2', '电池续航', '单次充电播放时长', '8', '小时', 9, 1, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0A010', '01J9Z8K2M4N5P6Q7R8S9T0V1W2', '电池续航', '开启降噪续航', '6', '小时', 10, 1, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0A011', '01J9Z8K2M4N5P6Q7R8S9T0V1W2', '电池续航', '充电仓综合续航', '36', '小时', 11, 1, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0A012', '01J9Z8K2M4N5P6Q7R8S9T0V1W2', '电池续航', '快充能力', '充电 10 分钟听歌 2 小时', NULL, 12, 0, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0A013', '01J9Z8K2M4N5P6Q7R8S9T0V1W2', '连接方式', '无线连接', 'Bluetooth 5.4', NULL, 13, 1, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0A014', '01J9Z8K2M4N5P6Q7R8S9T0V1W2', '连接方式', '支持音频编码', 'SBC、AAC、LDAC', NULL, 14, 1, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0A015', '01J9Z8K2M4N5P6Q7R8S9T0V1W2', '连接方式', '双设备连接', '支持（手机/平板/电脑同时连接，通话时智能切换）', NULL, 15, 1, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0A016', '01J9Z8K2M4N5P6Q7R8S9T0V1W2', '连接方式', '充电接口', 'Type-C 有线快充，兼容 Qi 5W 无线充电', NULL, 16, 1, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0A017', '01J9Z8K2M4N5P6Q7R8S9T0V1W2', '防护等级', '防水等级', 'IPX5', NULL, 17, 1, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0A018', '01J9Z8K2M4N5P6Q7R8S9T0V1W2', '防护等级', '防尘等级', '无（IPX5 不含防尘等级）', NULL, 18, 1, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0A019', '01J9Z8K2M4N5P6Q7R8S9T0V1W2', '防护等级', '充电仓防水等级', '不防水（IPX0）', NULL, 19, 1, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0A020', '01J9Z8K2M4N5P6Q7R8S9T0V1W2', '防护等级', '防水范围说明', '耳机本体仅防日常出汗与轻度小雨泼溅，不承受水流冲洗与浸泡', NULL, 20, 1, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0A021', '01J9Z8K2M4N5P6Q7R8S9T0V1W2', '防护等级', '使用禁忌', '不可游泳、淋浴、浸泡；充电仓不防水。禁止佩戴游泳/潜水/泡温泉，禁止用水龙头直接冲洗；进液导致短路属人为损坏，不在保修范围', NULL, 21, 1, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0A022', '01J9Z8K2M4N5P6Q7R8S9T0V1W2', '防护等级', '防水保修范围', '游泳/潜水/浸泡导致的进水不在保修范围', NULL, 22, 1, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0A023', '01J9Z8K2M4N5P6Q7R8S9T0V1W2', '售后与保修', '质保期', '12', '个月', 23, 1, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0A024', '01J9Z8K2M4N5P6Q7R8S9T0V1W2', '售后与保修', '保修范围', '非人为损坏', NULL, 24, 1, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0A025', '01J9Z8K2M4N5P6Q7R8S9T0V1W2', '售后与保修', '是否支持 7 天无理由', '支持', NULL, 25, 1, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0A026', '01J9Z8K2M4N5P6Q7R8S9T0V1W2', '包装清单', '耳机主机', '1 对', NULL, 26, 0, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0A027', '01J9Z8K2M4N5P6Q7R8S9T0V1W2', '包装清单', '充电仓', '1 个', NULL, 27, 0, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0A028', '01J9Z8K2M4N5P6Q7R8S9T0V1W2', '包装清单', '备用耳帽', 'S/M/L 各 1 对', NULL, 28, 0, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0A029', '01J9Z8K2M4N5P6Q7R8S9T0V1W2', '包装清单', '充电线', 'Type-C 充电线 1 条', NULL, 29, 0, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0A030', '01J9Z8K2M4N5P6Q7R8S9T0V1W2', '包装清单', '说明书与保修卡', '各 1 份', NULL, 30, 0, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0B001', '01J9Z8K2M4N5P6Q7R8S9T0V1X1', '基本信息', '型号', 'Aurora-Sound-Lite', NULL, 1, 1, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0B002', '01J9Z8K2M4N5P6Q7R8S9T0V1X1', '基本信息', '声学结构', '双 10W 全频扬声器 + 双被动低音辐射板', NULL, 2, 0, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0B003', '01J9Z8K2M4N5P6Q7R8S9T0V1X1', '基本信息', '机身材料', '耐磨编织材料 + 防摔硅胶角垫', NULL, 3, 0, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0B004', '01J9Z8K2M4N5P6Q7R8S9T0V1X1', '技术参数', '输出功率', '20', 'W', 4, 1, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0B005', '01J9Z8K2M4N5P6Q7R8S9T0V1X1', '技术参数', '频响范围', '60-20000', 'Hz', 5, 1, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0B006', '01J9Z8K2M4N5P6Q7R8S9T0V1X1', '技术参数', '蓝牙版本', '5.3', NULL, 6, 1, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0B007', '01J9Z8K2M4N5P6Q7R8S9T0V1X1', '技术参数', '指示灯说明', '蓝灯常亮=蓝牙配对成功；红灯闪烁=电量低于 10%；白灯呼吸闪烁=OTA 固件升级中', NULL, 7, 1, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0B008', '01J9Z8K2M4N5P6Q7R8S9T0V1X1', '电池续航', '电池容量', '4000', 'mAh', 8, 1, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0B009', '01J9Z8K2M4N5P6Q7R8S9T0V1X1', '电池续航', '连续播放时长', '15', '小时', 9, 1, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0B010', '01J9Z8K2M4N5P6Q7R8S9T0V1X1', '电池续航', '充满时长', '3', '小时', 10, 1, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0B011', '01J9Z8K2M4N5P6Q7R8S9T0V1X1', '连接方式', '无线连接', 'Bluetooth 5.3', NULL, 11, 1, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0B012', '01J9Z8K2M4N5P6Q7R8S9T0V1X1', '连接方式', '支持音频编码', 'SBC、AAC', NULL, 12, 1, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0B013', '01J9Z8K2M4N5P6Q7R8S9T0V1X1', '连接方式', '双设备连接', '不支持', NULL, 13, 1, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0B014', '01J9Z8K2M4N5P6Q7R8S9T0V1X1', '连接方式', '充电接口', 'Type-C', NULL, 14, 1, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0B015', '01J9Z8K2M4N5P6Q7R8S9T0V1X1', '防护等级', '防水等级', 'IP67', NULL, 15, 1, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0B016', '01J9Z8K2M4N5P6Q7R8S9T0V1X1', '防护等级', '防尘等级', 'IP6X（完全防尘）', NULL, 16, 1, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0B017', '01J9Z8K2M4N5P6Q7R8S9T0V1X1', '防护等级', '浸泡能力', '1 米深清水短时浸泡 30 分钟', NULL, 17, 1, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0B018', '01J9Z8K2M4N5P6Q7R8S9T0V1X1', '防护等级', '使用禁忌', '不可在海水、热水、温泉、桑拿或化学液体中使用；接口盖未闭合时不防水', NULL, 18, 1, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0B019', '01J9Z8K2M4N5P6Q7R8S9T0V1X1', '售后与保修', '质保期', '12', '个月', 19, 1, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0B020', '01J9Z8K2M4N5P6Q7R8S9T0V1X1', '售后与保修', '保修范围', '非人为损坏', NULL, 20, 1, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0B021', '01J9Z8K2M4N5P6Q7R8S9T0V1X1', '售后与保修', '是否支持 7 天无理由', '支持', NULL, 21, 1, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0B022', '01J9Z8K2M4N5P6Q7R8S9T0V1X1', '包装清单', '音箱主机', '1 台', NULL, 22, 0, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0B023', '01J9Z8K2M4N5P6Q7R8S9T0V1X1', '包装清单', '充电线', 'Type-C 充电线 1 条', NULL, 23, 0, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0B024', '01J9Z8K2M4N5P6Q7R8S9T0V1X1', '包装清单', '便携挂绳', '1 条', NULL, 24, 0, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0B025', '01J9Z8K2M4N5P6Q7R8S9T0V1X1', '包装清单', '说明书与保修卡', '各 1 份', NULL, 25, 0, '2026-06-01T02:00:00.000Z', '2026-09-18T03:00:00.000Z')
ON CONFLICT(id) DO UPDATE SET spu_id = excluded.spu_id, group_name = excluded.group_name, attr_name = excluded.attr_name, attr_value = excluded.attr_value, unit = excluded.unit, sort_order = excluded.sort_order, searchable = excluded.searchable, created_at = excluded.created_at, updated_at = excluded.updated_at;

-- 商品图片（product_images）

INSERT INTO product_images (id, product_id, url, sort_order, created_at) VALUES
  ('01J9Z8K2M4N5P6Q7R8S9T0V1Y1', '01J9Z8K2M4N5P6Q7R8S9T0V1W2', 'https://img.dshop.example.com/p/aurora-buds-pro-1.jpg', 0, '2026-06-01T02:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0V1Y2', '01J9Z8K2M4N5P6Q7R8S9T0V1W2', 'https://img.dshop.example.com/p/aurora-buds-pro-2.jpg', 1, '2026-06-01T02:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0V1Y3', '01J9Z8K2M4N5P6Q7R8S9T0V1X1', 'https://img.dshop.example.com/p/aurora-sound-lite-1.jpg', 0, '2026-07-10T02:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0V1Y4', '01J9Z8K2M4N5P6Q7R8S9T0V1X1', 'https://img.dshop.example.com/p/aurora-sound-lite-2.jpg', 1, '2026-07-10T02:00:00.000Z')
ON CONFLICT(id) DO UPDATE SET product_id = excluded.product_id, url = excluded.url, sort_order = excluded.sort_order, created_at = excluded.created_at;

-- 会员（users）
--   phone 加密存储；phone_hash = HMAC-SHA256(PHONE_HASH_PEPPER, 规范化 11 位)
--   两者均由 scripts/build-seed-sql.ts 用运行环境密钥现场派生（IV 由手机号确定性派生，保证幂等）。

INSERT INTO users (id, phone, phone_hash, nickname, avatar_url, status, wechat_openid, wechat_unionid, created_at, updated_at) VALUES
  ('01J9Z8K2M4N5P6Q7R8S9T0Z001', 'v1.q97t1JQ6eFBfWjrh.kEsQm6U1BxIfq8XEFHJ6oMKcYZcq4Xo1v-vO', 'a2d6d7e9e0c402b25784a0381d5d88453d8dbc5123da7a39464c0c1786c4e333', '张伟', 'https://img.dshop.example.com/u/avatar-1001.png', 'active', NULL, NULL, '2026-03-05T02:00:00.000Z', '2026-09-16T06:20:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0Z002', 'v1.YMP-WrzmlJvbyg-J.rAf-KEqrWz6lE6fu7hJY6Vhvzc7K-XACxOuT', '6848035dacdd2c958036319559fbbe25e8d2154302bbe298bfcf925ce47a3f6a', '李晓雨', 'https://img.dshop.example.com/u/avatar-1002.png', 'active', NULL, NULL, '2026-04-12T02:00:00.000Z', '2026-09-20T06:30:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0Z003', 'v1.LbKImkLqcBA125hf.1ETSqPQZ1iUHLCiAUehkHAOE7ZQet_ouSCgu', 'b19e0c9e0021362c578529f4686354fa9df4412521a012eb29c93b964de434ce', '王浩然', 'https://img.dshop.example.com/u/avatar-1003.png', 'active', NULL, NULL, '2026-05-20T02:00:00.000Z', '2026-09-21T02:30:00.000Z')
ON CONFLICT(phone_hash) DO UPDATE SET id = excluded.id, phone = excluded.phone, nickname = excluded.nickname, avatar_url = excluded.avatar_url, status = excluded.status, wechat_openid = excluded.wechat_openid, wechat_unionid = excluded.wechat_unionid, created_at = excluded.created_at, updated_at = excluded.updated_at;

-- 订单（orders）—— 主单状态由子单聚合，不单独维护

INSERT INTO orders (id, order_no, user_id, status, total_amount, discount_amount, freight_amount, pay_amount, address_snapshot, coupon_id, channel, pay_deadline, paid_at, completed_at, cancelled_at, remark, created_at, updated_at) VALUES
  ('01J9Z8K2M4N5P6Q7R8S9T0W001', 'DS20260920143000123', '01J9Z8K2M4N5P6Q7R8S9T0Z002', 'SHIPPED', 35700, 2000, 0, 33700, '{"receiver_name":"李晓雨","receiver_phone":"13888888888","province":"浙江省","city":"杭州市","district":"西湖区","detail":"文三路 478 号华星时代广场 A 座 1203 室","postal_code":"310012"}', NULL, 'web', '2026-09-20T06:45:00.000Z', '2026-09-20T06:31:22.000Z', NULL, NULL, 'Golden 场景②：订单物流状态查询联动', '2026-09-20T06:30:00.000Z', '2026-09-20T09:30:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0W002', 'DS20260916142000001', '01J9Z8K2M4N5P6Q7R8S9T0Z001', 'COMPLETED', 12900, 0, 0, 12900, '{"receiver_name":"张伟","receiver_phone":"13912345678","province":"浙江省","city":"杭州市","district":"滨江区","detail":"江南大道 3588 号网商路 699 号 5 幢 302 室","postal_code":"310052"}', NULL, 'app', '2026-09-16T06:35:00.000Z', '2026-09-16T06:21:10.000Z', '2026-09-17T06:20:00.000Z', NULL, '主单全 COMPLETED 分支（已签收含轨迹）', '2026-09-16T06:20:00.000Z', '2026-09-17T06:20:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0W003', 'DS20260921103000456', '01J9Z8K2M4N5P6Q7R8S9T0Z003', 'PAID', 22800, 0, 0, 22800, '{"receiver_name":"王浩然","receiver_phone":"13712345678","province":"江苏省","city":"南京市","district":"鼓楼区","detail":"中山北路 101 号 3 单元 802 室","postal_code":"210009"}', NULL, 'miniprogram', '2026-09-21T02:45:00.000Z', '2026-09-21T02:31:05.000Z', NULL, NULL, '含 CANCELLED 子单分支（剔除后其余 → PAID，仓库配货中）', '2026-09-21T02:30:00.000Z', '2026-09-21T03:10:00.000Z')
ON CONFLICT(order_no) DO UPDATE SET id = excluded.id, user_id = excluded.user_id, status = excluded.status, total_amount = excluded.total_amount, discount_amount = excluded.discount_amount, freight_amount = excluded.freight_amount, pay_amount = excluded.pay_amount, address_snapshot = excluded.address_snapshot, coupon_id = excluded.coupon_id, channel = excluded.channel, pay_deadline = excluded.pay_deadline, paid_at = excluded.paid_at, completed_at = excluded.completed_at, cancelled_at = excluded.cancelled_at, remark = excluded.remark, created_at = excluded.created_at, updated_at = excluded.updated_at;

-- 子单（sub_orders）—— express_* / shipped_at 是场景②物流查询依据

INSERT INTO sub_orders (id, sub_order_no, order_id, merchant_id, store_id, status, subtotal, discount_alloc, freight, commission_amount, express_company, express_company_code, express_no, shipped_at, received_at, settled, created_at, updated_at) VALUES
  ('01J9Z8K2M4N5P6Q7R8S9T0S001', 'DS20260920143000123-01', '01J9Z8K2M4N5P6Q7R8S9T0W001', '01J9Z8K2M4N5P6Q7R8S9T0V1M1', '01J9Z8K2M4N5P6Q7R8S9T0V1R1', 'SHIPPED', 25800, 1600, 0, 0, '中通快递', 'ZTO', 'ZT9988776655', '2026-09-20T09:00:00.000Z', NULL, 0, '2026-09-20T06:30:00.000Z', '2026-09-20T09:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0S002', 'DS20260920143000123-02', '01J9Z8K2M4N5P6Q7R8S9T0W001', '01J9Z8K2M4N5P6Q7R8S9T0V1M1', '01J9Z8K2M4N5P6Q7R8S9T0V1R1', 'SHIPPED', 9900, 400, 0, 0, '顺丰速运', 'SF', 'SF1029384756', '2026-09-20T09:30:00.000Z', NULL, 0, '2026-09-20T06:30:00.000Z', '2026-09-20T09:30:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0S003', 'DS20260916142000001-01', '01J9Z8K2M4N5P6Q7R8S9T0W002', '01J9Z8K2M4N5P6Q7R8S9T0V1M1', '01J9Z8K2M4N5P6Q7R8S9T0V1R1', 'COMPLETED', 12900, 0, 0, 0, '顺丰速运', 'SF', 'SF1029384756', '2026-09-16T09:00:00.000Z', '2026-09-17T06:20:00.000Z', 0, '2026-09-16T06:20:00.000Z', '2026-09-17T06:20:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0S004', 'DS20260921103000456-01', '01J9Z8K2M4N5P6Q7R8S9T0W003', '01J9Z8K2M4N5P6Q7R8S9T0V1M1', '01J9Z8K2M4N5P6Q7R8S9T0V1R1', 'PAID', 9900, 0, 0, 0, NULL, NULL, NULL, NULL, NULL, 0, '2026-09-21T02:30:00.000Z', '2026-09-21T02:30:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0S005', 'DS20260921103000456-02', '01J9Z8K2M4N5P6Q7R8S9T0W003', '01J9Z8K2M4N5P6Q7R8S9T0V1M1', '01J9Z8K2M4N5P6Q7R8S9T0V1R1', 'CANCELLED', 12900, 0, 0, 0, NULL, NULL, NULL, NULL, NULL, 0, '2026-09-21T02:30:00.000Z', '2026-09-21T03:10:00.000Z')
ON CONFLICT(sub_order_no) DO UPDATE SET id = excluded.id, order_id = excluded.order_id, merchant_id = excluded.merchant_id, store_id = excluded.store_id, status = excluded.status, subtotal = excluded.subtotal, discount_alloc = excluded.discount_alloc, freight = excluded.freight, commission_amount = excluded.commission_amount, express_company = excluded.express_company, express_company_code = excluded.express_company_code, express_no = excluded.express_no, shipped_at = excluded.shipped_at, received_at = excluded.received_at, settled = excluded.settled, created_at = excluded.created_at, updated_at = excluded.updated_at;

-- 订单商品快照（order_items）—— 下单瞬间固化

INSERT INTO order_items (id, sub_order_id, order_id, spu_id, sku_id, title, image, spec, unit_price, quantity, subtotal, created_at) VALUES
  ('01J9Z8K2M4N5P6Q7R8S9T0J001', '01J9Z8K2M4N5P6Q7R8S9T0S001', '01J9Z8K2M4N5P6Q7R8S9T0W001', '01J9Z8K2M4N5P6Q7R8S9T0V1W2', '01J9Z8K2M4N5P6Q7R8S9T0K001', '极光 Pro 真无线降噪耳机', 'https://img.dshop.example.com/p/aurora-buds-pro-1.jpg', '{"颜色":"曜石黑","版本":"降噪版"}', 12900, 2, 25800, '2026-09-20T06:30:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0J002', '01J9Z8K2M4N5P6Q7R8S9T0S002', '01J9Z8K2M4N5P6Q7R8S9T0W001', '01J9Z8K2M4N5P6Q7R8S9T0V1X1', '01J9Z8K2M4N5P6Q7R8S9T0K003', '极光 Lite 便携户外蓝牙音箱', 'https://img.dshop.example.com/p/aurora-sound-lite-1.jpg', '{"颜色":"军绿色","版本":"标准版"}', 9900, 1, 9900, '2026-09-20T06:30:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0J003', '01J9Z8K2M4N5P6Q7R8S9T0S003', '01J9Z8K2M4N5P6Q7R8S9T0W002', '01J9Z8K2M4N5P6Q7R8S9T0V1W2', '01J9Z8K2M4N5P6Q7R8S9T0K001', '极光 Pro 真无线降噪耳机', 'https://img.dshop.example.com/p/aurora-buds-pro-1.jpg', '{"颜色":"曜石黑","版本":"降噪版"}', 12900, 1, 12900, '2026-09-16T06:20:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0J004', '01J9Z8K2M4N5P6Q7R8S9T0S004', '01J9Z8K2M4N5P6Q7R8S9T0W003', '01J9Z8K2M4N5P6Q7R8S9T0V1X1', '01J9Z8K2M4N5P6Q7R8S9T0K003', '极光 Lite 便携户外蓝牙音箱', 'https://img.dshop.example.com/p/aurora-sound-lite-1.jpg', '{"颜色":"军绿色","版本":"标准版"}', 9900, 1, 9900, '2026-09-21T02:30:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0J005', '01J9Z8K2M4N5P6Q7R8S9T0S005', '01J9Z8K2M4N5P6Q7R8S9T0W003', '01J9Z8K2M4N5P6Q7R8S9T0V1W2', '01J9Z8K2M4N5P6Q7R8S9T0K002', '极光 Pro 真无线降噪耳机', 'https://img.dshop.example.com/p/aurora-buds-pro-1.jpg', '{"颜色":"冰晶白","版本":"降噪版"}', 12900, 1, 12900, '2026-09-21T02:30:00.000Z')
ON CONFLICT(id) DO UPDATE SET sub_order_id = excluded.sub_order_id, order_id = excluded.order_id, spu_id = excluded.spu_id, sku_id = excluded.sku_id, title = excluded.title, image = excluded.image, spec = excluded.spec, unit_price = excluded.unit_price, quantity = excluded.quantity, subtotal = excluded.subtotal, created_at = excluded.created_at;

-- 订单状态日志 / 物流轨迹（order_status_logs）
--   kind = 'status' → 状态流转；kind = 'trace' → 物流轨迹（remark 即 desc，occurred_at 即 time）

INSERT INTO order_status_logs (id, order_id, sub_order_id, kind, from_status, to_status, actor_type, actor_id, remark, occurred_at, created_at) VALUES
  ('01J9Z8K2M4N5P6Q7R8S9T0E001', '01J9Z8K2M4N5P6Q7R8S9T0W001', NULL, 'status', NULL, 'PENDING_PAYMENT', 'user', '01J9Z8K2M4N5P6Q7R8S9T0Z002', '用户提交订单，等待支付', '2026-09-20T06:30:00.000Z', '2026-09-20T06:30:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0E002', '01J9Z8K2M4N5P6Q7R8S9T0W001', NULL, 'status', 'PENDING_PAYMENT', 'PAID', 'system', NULL, '支付成功，库存锁定转实扣', '2026-09-20T06:31:22.000Z', '2026-09-20T06:31:22.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0E003', '01J9Z8K2M4N5P6Q7R8S9T0W001', '01J9Z8K2M4N5P6Q7R8S9T0S001', 'status', 'PAID', 'SHIPPED', 'merchant', NULL, '子单 -01 已发货（中通快递 ZT9988776655）', '2026-09-20T09:00:00.000Z', '2026-09-20T09:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0E004', '01J9Z8K2M4N5P6Q7R8S9T0W001', '01J9Z8K2M4N5P6Q7R8S9T0S002', 'status', 'PAID', 'SHIPPED', 'merchant', NULL, '子单 -02 已发货（顺丰速运 SF1029384756）', '2026-09-20T09:30:00.000Z', '2026-09-20T09:30:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0E005', '01J9Z8K2M4N5P6Q7R8S9T0W001', '01J9Z8K2M4N5P6Q7R8S9T0S001', 'trace', NULL, 'SHIPPED', 'system', NULL, '已揽收', '2026-09-20T09:00:00.000Z', '2026-09-20T09:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0E006', '01J9Z8K2M4N5P6Q7R8S9T0W001', '01J9Z8K2M4N5P6Q7R8S9T0S002', 'trace', NULL, 'SHIPPED', 'system', NULL, '已揽收', '2026-09-20T09:30:00.000Z', '2026-09-20T09:30:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0E007', '01J9Z8K2M4N5P6Q7R8S9T0W001', '01J9Z8K2M4N5P6Q7R8S9T0S001', 'trace', NULL, 'SHIPPED', 'system', NULL, '快件已到达【杭州转运中心】', '2026-09-20T13:40:00.000Z', '2026-09-20T13:40:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0E008', '01J9Z8K2M4N5P6Q7R8S9T0W001', '01J9Z8K2M4N5P6Q7R8S9T0S002', 'trace', NULL, 'SHIPPED', 'system', NULL, '快件已到达【杭州中转场】', '2026-09-20T15:20:00.000Z', '2026-09-20T15:20:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0E009', '01J9Z8K2M4N5P6Q7R8S9T0W001', '01J9Z8K2M4N5P6Q7R8S9T0S002', 'trace', NULL, 'SHIPPED', 'system', NULL, '快件已到达【上海转运中心】，正在发往下一站', '2026-09-21T01:05:00.000Z', '2026-09-21T01:05:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0E010', '01J9Z8K2M4N5P6Q7R8S9T0W001', '01J9Z8K2M4N5P6Q7R8S9T0S001', 'trace', NULL, 'SHIPPED', 'system', NULL, '快件已到达【上海转运中心】，正在发往下一站', '2026-09-21T02:10:00.000Z', '2026-09-21T02:10:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0E011', '01J9Z8K2M4N5P6Q7R8S9T0W002', NULL, 'status', NULL, 'PENDING_PAYMENT', 'user', '01J9Z8K2M4N5P6Q7R8S9T0Z001', '用户提交订单，等待支付', '2026-09-16T06:20:00.000Z', '2026-09-16T06:20:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0E012', '01J9Z8K2M4N5P6Q7R8S9T0W002', NULL, 'status', 'PENDING_PAYMENT', 'PAID', 'system', NULL, '支付成功，库存锁定转实扣', '2026-09-16T06:21:10.000Z', '2026-09-16T06:21:10.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0E013', '01J9Z8K2M4N5P6Q7R8S9T0W002', '01J9Z8K2M4N5P6Q7R8S9T0S003', 'status', 'PAID', 'SHIPPED', 'merchant', NULL, '子单 -01 已发货（顺丰速运 SF1029384756）', '2026-09-16T09:00:00.000Z', '2026-09-16T09:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0E014', '01J9Z8K2M4N5P6Q7R8S9T0W002', '01J9Z8K2M4N5P6Q7R8S9T0S003', 'trace', NULL, 'SHIPPED', 'system', NULL, '已揽收', '2026-09-16T09:00:00.000Z', '2026-09-16T09:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0E015', '01J9Z8K2M4N5P6Q7R8S9T0W002', '01J9Z8K2M4N5P6Q7R8S9T0S003', 'trace', NULL, 'SHIPPED', 'system', NULL, '快件已到达【杭州滨江中转场】', '2026-09-16T18:30:00.000Z', '2026-09-16T18:30:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0E016', '01J9Z8K2M4N5P6Q7R8S9T0W002', '01J9Z8K2M4N5P6Q7R8S9T0S003', 'trace', NULL, 'SHIPPED', 'system', NULL, '快件已到达【杭州西湖网点】，正在派送中', '2026-09-17T02:00:00.000Z', '2026-09-17T02:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0E017', '01J9Z8K2M4N5P6Q7R8S9T0W002', '01J9Z8K2M4N5P6Q7R8S9T0S003', 'trace', NULL, 'COMPLETED', 'system', NULL, '快件已投递至丰巢快递柜，取件人凭码签收', '2026-09-17T06:20:00.000Z', '2026-09-17T06:20:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0E018', '01J9Z8K2M4N5P6Q7R8S9T0W002', '01J9Z8K2M4N5P6Q7R8S9T0S003', 'status', 'SHIPPED', 'COMPLETED', 'system', NULL, '物流签收，子单完成', '2026-09-17T06:20:00.000Z', '2026-09-17T06:20:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0E019', '01J9Z8K2M4N5P6Q7R8S9T0W003', NULL, 'status', NULL, 'PENDING_PAYMENT', 'user', '01J9Z8K2M4N5P6Q7R8S9T0Z003', '用户提交订单，等待支付', '2026-09-21T02:30:00.000Z', '2026-09-21T02:30:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0E020', '01J9Z8K2M4N5P6Q7R8S9T0W003', NULL, 'status', 'PENDING_PAYMENT', 'PAID', 'system', NULL, '支付成功，库存锁定转实扣', '2026-09-21T02:31:05.000Z', '2026-09-21T02:31:05.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0E021', '01J9Z8K2M4N5P6Q7R8S9T0W003', '01J9Z8K2M4N5P6Q7R8S9T0S004', 'trace', NULL, 'PAID', 'merchant', NULL, '商家正在打包拣货，预计 24 小时内发出', '2026-09-21T02:45:00.000Z', '2026-09-21T02:45:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0E022', '01J9Z8K2M4N5P6Q7R8S9T0W003', '01J9Z8K2M4N5P6Q7R8S9T0S005', 'status', 'PAID', 'CANCELLED', 'user', '01J9Z8K2M4N5P6Q7R8S9T0Z003', '冰晶白降噪版缺货（预计 2026-09-28 到货），用户取消该子单并退款', '2026-09-21T03:10:00.000Z', '2026-09-21T03:10:00.000Z')
ON CONFLICT(id) DO UPDATE SET order_id = excluded.order_id, sub_order_id = excluded.sub_order_id, kind = excluded.kind, from_status = excluded.from_status, to_status = excluded.to_status, actor_type = excluded.actor_type, actor_id = excluded.actor_id, remark = excluded.remark, occurred_at = excluded.occurred_at, created_at = excluded.created_at;

-- 售后单（aftersales）

INSERT INTO aftersales (id, aftersale_no, order_id, sub_order_id, user_id, sku_id, item_title, quantity, type, status, reason, evidence_urls, refund_amount, return_address, return_express_company, return_express_no, deadline_at, applied_at, refunded_at, created_at, updated_at) VALUES
  ('01J9Z8K2M4N5P6Q7R8S9T0F001', 'AS20260922001', '01J9Z8K2M4N5P6Q7R8S9T0W001', '01J9Z8K2M4N5P6Q7R8S9T0S001', '01J9Z8K2M4N5P6Q7R8S9T0Z002', '01J9Z8K2M4N5P6Q7R8S9T0K001', '极光 Pro 真无线降噪耳机', 1, 'return_refund', 'WAIT_BUYER_RETURN', '商品与描述不符', '["https://img.dshop.example.com/evidence/as20260922001-1.jpg","https://img.dshop.example.com/evidence/as20260922001-2.jpg"]', 12900, '{"receiver_name":"极光售后服务中心","receiver_phone":"057188880000","province":"浙江省","city":"杭州市","district":"西湖区","detail":"三墩镇西园一路 8 号 DShop 杭州仓退货收货组","postal_code":"310030"}', NULL, NULL, '2026-09-29T01:00:00.000Z', '2026-09-22T01:00:00.000Z', NULL, '2026-09-22T01:00:00.000Z', '2026-09-22T03:20:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0F002', 'AS20260921001', '01J9Z8K2M4N5P6Q7R8S9T0W003', '01J9Z8K2M4N5P6Q7R8S9T0S005', '01J9Z8K2M4N5P6Q7R8S9T0Z003', '01J9Z8K2M4N5P6Q7R8S9T0K002', '极光 Pro 真无线降噪耳机', 1, 'refund_only', 'REFUNDED', '商品缺货，无法按约定时间发货，申请仅退款', '["https://img.dshop.example.com/evidence/as20260921001-1.jpg"]', 12900, NULL, NULL, NULL, NULL, '2026-09-21T01:30:00.000Z', '2026-09-21T03:40:00.000Z', '2026-09-21T01:30:00.000Z', '2026-09-21T03:40:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0F003', 'AS20260917001', '01J9Z8K2M4N5P6Q7R8S9T0W002', '01J9Z8K2M4N5P6Q7R8S9T0S003', '01J9Z8K2M4N5P6Q7R8S9T0Z001', '01J9Z8K2M4N5P6Q7R8S9T0K001', '极光 Pro 真无线降噪耳机', 1, 'refund_only', 'PENDING_MERCHANT', '蓝牙偶发断连，商品与描述不符', '["https://img.dshop.example.com/evidence/as20260917001-1.jpg","https://img.dshop.example.com/evidence/as20260917001-2.jpg","https://img.dshop.example.com/evidence/as20260917001-3.jpg"]', 12900, NULL, NULL, NULL, '2026-09-24T01:10:00.000Z', '2026-09-17T01:10:00.000Z', NULL, '2026-09-17T01:10:00.000Z', '2026-09-17T01:10:00.000Z')
ON CONFLICT(aftersale_no) DO UPDATE SET id = excluded.id, order_id = excluded.order_id, sub_order_id = excluded.sub_order_id, user_id = excluded.user_id, sku_id = excluded.sku_id, item_title = excluded.item_title, quantity = excluded.quantity, type = excluded.type, status = excluded.status, reason = excluded.reason, evidence_urls = excluded.evidence_urls, refund_amount = excluded.refund_amount, return_address = excluded.return_address, return_express_company = excluded.return_express_company, return_express_no = excluded.return_express_no, deadline_at = excluded.deadline_at, applied_at = excluded.applied_at, refunded_at = excluded.refunded_at, created_at = excluded.created_at, updated_at = excluded.updated_at;

-- 售后时间线（aftersale_logs）—— Agent /aftersales/{aftersaleNo} 的 timeline 唯一来源

INSERT INTO aftersale_logs (id, aftersale_id, from_status, to_status, actor_type, actor_id, remark, occurred_at, created_at) VALUES
  ('01J9Z8K2M4N5P6Q7R8S9T0G001', '01J9Z8K2M4N5P6Q7R8S9T0F001', NULL, 'PENDING_MERCHANT', 'buyer', '01J9Z8K2M4N5P6Q7R8S9T0Z002', '用户提交退货退款申请', '2026-09-22T01:00:00.000Z', '2026-09-22T01:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0G002', '01J9Z8K2M4N5P6Q7R8S9T0F001', 'PENDING_MERCHANT', 'WAIT_BUYER_RETURN', 'merchant', NULL, '商家同意，已提供退货地址', '2026-09-22T03:20:00.000Z', '2026-09-22T03:20:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0G003', '01J9Z8K2M4N5P6Q7R8S9T0F001', 'WAIT_BUYER_RETURN', 'WAIT_BUYER_RETURN', 'system', NULL, '系统自动提醒：请于 2026-09-29 前寄回，超时申请将自动关闭', '2026-09-23T02:00:00.000Z', '2026-09-23T02:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0G004', '01J9Z8K2M4N5P6Q7R8S9T0F002', NULL, 'PENDING_MERCHANT', 'buyer', '01J9Z8K2M4N5P6Q7R8S9T0Z003', '用户提交仅退款申请（缺货）', '2026-09-21T01:30:00.000Z', '2026-09-21T01:30:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0G005', '01J9Z8K2M4N5P6Q7R8S9T0F002', 'PENDING_MERCHANT', 'REFUNDING', 'merchant', NULL, '商家同意仅退款，已发起渠道退款', '2026-09-21T03:10:00.000Z', '2026-09-21T03:10:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0G006', '01J9Z8K2M4N5P6Q7R8S9T0F002', 'REFUNDING', 'REFUNDED', 'system', NULL, '渠道退款成功，12900 分原路退回微信支付', '2026-09-21T03:40:00.000Z', '2026-09-21T03:40:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0G007', '01J9Z8K2M4N5P6Q7R8S9T0F003', NULL, 'PENDING_MERCHANT', 'buyer', '01J9Z8K2M4N5P6Q7R8S9T0Z001', '用户提交仅退款申请（蓝牙偶发断连）', '2026-09-17T01:10:00.000Z', '2026-09-17T01:10:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0G008', '01J9Z8K2M4N5P6Q7R8S9T0F003', 'PENDING_MERCHANT', 'PENDING_MERCHANT', 'platform', '01J9Z8K2M4N5P6Q7R8S9T0V1A1', '平台客服介入：已通知商家在 48 小时内处理，逾期自动同意', '2026-09-17T05:30:00.000Z', '2026-09-17T05:30:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0G009', '01J9Z8K2M4N5P6Q7R8S9T0F003', 'PENDING_MERCHANT', 'PENDING_MERCHANT', 'system', NULL, '系统催办：商家处理时效剩余 24 小时', '2026-09-18T01:10:00.000Z', '2026-09-18T01:10:00.000Z')
ON CONFLICT(id) DO UPDATE SET aftersale_id = excluded.aftersale_id, from_status = excluded.from_status, to_status = excluded.to_status, actor_type = excluded.actor_type, actor_id = excluded.actor_id, remark = excluded.remark, occurred_at = excluded.occurred_at, created_at = excluded.created_at;

-- 售后政策（aftersale_policies）—— PiEcho 政策语料唯一来源
--   五类全覆盖：return / refund / exchange / freight / warranty
--   warranty 正文明确「人为损坏、进液/进水不在保修范围」（场景①依据）

INSERT INTO aftersale_policies (id, category, title, content, version, effective_from, effective_to, status, tags, created_by, created_at, updated_at) VALUES
  ('01J9Z8K2M4N5P6Q7R8S9T0P001', 'return', '7 天无理由退货规则', '## 适用范围

自确认签收之日起 7 个自然日内（以物流签收时间为准），商品完好、原装配件齐全且不影响二次销售，支持 7 天无理由退货。

## 「不影响二次销售」的定义

- 主机及外壳无划痕 / 磕碰 / 磨损；
- 防伪标签、SN 码贴纸完整未撕毁；
- 包装盒原样保留，说明书、充电线、备用耳帽等附赠配件完整无缺失。

## 不支持 7 天无理由的品类

- 贴身类商品：已开封试戴的定制耳塞套、入耳式耳机有明显耳道污垢残留；
- 清仓特惠 / 样机处理商品（页面已标注「不支持退换」）；
- 因人为误用、进水、摔落导致物理损毁的商品。

> 耳机类商品请注意：**耳机本体为 IPX5，充电仓不防水**。因游泳、淋浴、浸泡、水流冲洗导致进液损毁的，属人为损坏，不支持 7 天无理由退货。', '1.0.0', '2026-06-01T00:00:00.000Z', NULL, 'effective', '["无理由","时效","签收","不支持品类"]', '01J9Z8K2M4N5P6Q7R8S9T0V1A1', '2026-06-01T00:00:00.000Z', '2026-08-15T02:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0P002', 'refund', '退款处理与到账时效规则', '## 退款发起

售后申请经商家（或平台客服介入）审核同意后，进入退款流程。退款金额按实付金额计算，含已分摊的优惠与运费（按 `discount_alloc` / `freight` 分摊结果）。

## 到账时效

- 微信支付：退款审核通过后 1–3 个工作日原路退回；
- 支付宝：退款审核通过后 1–3 个工作日原路退回；
- 银行渠道：以渠道回执为准，最长不超过 7 个工作日。

## 部分退款

仅退部分子单时，只将该子单置为已取消并退款，**主单状态不置为已取消**。

## 不予退款的情形

- 售后申请被驳回（如超过 7 天无理由期限、商品已影响二次销售）；
- 经检测属人为损坏（含**进液 / 进水**、自行拆解、私自刷机、外力跌落破损）。', '1.0.0', '2026-06-01T00:00:00.000Z', NULL, 'effective', '["退款","到账时效","部分退款"]', '01J9Z8K2M4N5P6Q7R8S9T0V1A1', '2026-06-01T00:00:00.000Z', '2026-08-15T02:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0P003', 'exchange', '换货规则（同型号同规格）', '## 可换货情形

- 签收后 7 个自然日内，商品存在出厂质量问题、功能性故障；
- 收到商品与订单型号 / 颜色 / 规格不一致，或存在明显外观瑕疵。

## 换货流程

1. 买家提交换货申请并上传凭证；
2. 商家审核通过后提供寄回地址；
3. 买家寄回商品，商家确认收货并质检；
4. 商家发出同型号同规格新品，物流单号在订单详情可见。

## 限制

- 换货仅限同型号同规格；如需更换型号或颜色，请按退货后重新下单处理；
- 人为损坏（含**进液 / 进水**、摔落、私自拆解）不支持换货；
- 缺货型号可协商改为退款，或以**官方指导价 60% 折扣换新**。', '1.0.0', '2026-06-01T00:00:00.000Z', NULL, 'effective', '["换货","质量问题","同规格"]', '01J9Z8K2M4N5P6Q7R8S9T0V1A1', '2026-06-01T00:00:00.000Z', '2026-08-15T02:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0P004', 'freight', '退换货运费归属规则', '## 商家承担

以下情形由商家承担退换货运费：

- 经官方售后检测确认存在出厂质量问题、功能性故障；
- 仓库发错型号、漏发核心配件；
- 物流运输途中导致包装严重破损。

**承担方式**：买家先行垫付寄回运费，仓库签收质检无误后原路返还运费，**最高补贴 12 元**。

## 买家承担

以下情形由买家承担退换货运费：

- 个人主观原因（听感不习惯、不喜欢外观颜色、重复拍错）；
- 未与客服沟通擅自寄回导致的拒收二次派送费用；
- 因人为损坏（含**进液 / 进水**）发起的退换。

## 运费金额参考

- 订单满 99 元包邮；
- 未满额订单固定运费 800 分（8 元）。', '1.0.0', '2026-06-01T00:00:00.000Z', NULL, 'effective', '["运费","退货","换货","补贴"]', '01J9Z8K2M4N5P6Q7R8S9T0V1A1', '2026-06-01T00:00:00.000Z', '2026-08-15T02:00:00.000Z'),
  ('01J9Z8K2M4N5P6Q7R8S9T0P005', 'warranty', '维修与质保规则（非人为损坏）', '## 质保期

旗舰电子类产品自签收之日起享 **1 年官方全国联保**（12 个月）。

## 质保范围内的免费服务

质保期内**非人为**性能故障（单边耳机无声、蓝牙偶发断连、充电仓无法蓄电等），免费维修或以换代修。

## 人为损坏界定（**不属免费质保**）

- **进液 / 进水**：游泳、潜水、浸泡、淋浴、水流冲洗、汗液严重渗透导致电路板短路或电池仓损毁；
- 自行拆解、私自刷入第三方固件；
- 外力跌落、挤压导致的物理破损。

> 以极光 Pro 真无线降噪耳机为例：耳机本体防护等级为 **IPX5**（仅防日常出汗与轻度小雨泼溅），**充电仓本体不具备防水能力（IPX0）**。
> 因此「佩戴游泳后单耳无法开机」属典型进液人为损坏，**不在保修范围**。

## 超保与人为损坏的处理

超出质保范围的人为损坏，仅支持官方有偿折扣换新：**按官方指导价 60% 换购同型号单品**。', '1.0.0', '2026-06-01T00:00:00.000Z', NULL, 'effective', '["质保","保修","人为损坏","进液","进水"]', '01J9Z8K2M4N5P6Q7R8S9T0V1A1', '2026-06-01T00:00:00.000Z', '2026-08-15T02:00:00.000Z')
ON CONFLICT(id) DO UPDATE SET category = excluded.category, title = excluded.title, content = excluded.content, version = excluded.version, effective_from = excluded.effective_from, effective_to = excluded.effective_to, status = excluded.status, tags = excluded.tags, created_by = excluded.created_by, created_at = excluded.created_at, updated_at = excluded.updated_at;

PRAGMA foreign_keys = ON;
