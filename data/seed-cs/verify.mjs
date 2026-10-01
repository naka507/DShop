#!/usr/bin/env node
/**
 * data/seed-cs/verify.mjs —— 种子数据集自检（**零 npm 依赖**，仅用 node: 内置模块）。
 *
 * 用法：node data/seed-cs/verify.mjs
 *
 * 断言清单：
 *  1. order_no /^DS\d{17}$/、sub_order_no /^DS\d{17}-\d{2}$/、aftersale_no /^AS\d{11}$/
 *  2. 单号内嵌时间戳（UTC+8）→ UTC 后与对应记录 created_at 一致（容差 1s）
 *  3. 所有 status 取值落在 packages/shared/src/enums.ts 的枚举集合内
 *  4. 商品属性中**不存在**任何含「心率」的属性名或值（场景③负面断言）
 *  5. Pro 的属性分组中存在「防护等级」
 *  6. seed_cs.sql 的 ON CONFLICT 次数 == INSERT INTO 次数
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import zlib from "node:zlib";

const DIR = path.dirname(fileURLToPath(import.meta.url));

/* -------------------------------------------------------------------------- */
/* 断言小工具                                                                  */
/* -------------------------------------------------------------------------- */

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    const detail = fn();
    passed += 1;
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    failures.push({ name, message: error.message });
    console.log(`  FAIL ${name} — ${error.message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function eq(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}（期望 ${expected}，实际 ${actual}）`);
}

/* -------------------------------------------------------------------------- */
/* 枚举集合（逐字照录 packages/shared/src/enums.ts）                            */
/* -------------------------------------------------------------------------- */

const ENUMS = {
  orderStatus: ["PENDING_PAYMENT", "PAID", "SHIPPED", "COMPLETED", "CANCELLED"],
  subOrderStatus: ["PENDING_PAYMENT", "PAID", "SHIPPED", "COMPLETED", "CANCELLED"],
  channel: ["web", "miniprogram", "app"],
  aftersaleType: ["refund_only", "return_refund"],
  aftersaleStatus: [
    "PENDING_MERCHANT", "WAIT_BUYER_RETURN", "BUYER_RETURNED", "MERCHANT_RECEIVED",
    "REFUNDING", "REFUNDED", "REJECTED", "CANCELLED",
  ],
  aftersaleActor: ["buyer", "merchant", "platform", "system"],
  policyCategory: ["return", "refund", "exchange", "freight", "warranty"],
  policyStatus: ["draft", "effective", "archived"],
  productStatus: ["draft", "pending_review", "onsale", "offsale", "rejected"],
  skuStatus: ["active", "inactive"],
  merchantType: ["self", "vendor", "branch"],
  merchantStatus: ["pending", "approved", "suspended", "rejected"],
  storeType: ["warehouse", "store"],
  userStatus: ["active", "disabled"],
  logKind: ["status", "trace"],
  logActorType: ["system", "user", "admin", "merchant"],
};

/* -------------------------------------------------------------------------- */
/* 单号正则与 UTC+8 ⇔ UTC 换算（复刻 packages/shared/src/ids.ts）                */
/* -------------------------------------------------------------------------- */

const ID_TIMESTAMP_OFFSET_MINUTES = 8 * 60;

const ORDER_NO_PATTERN = /^DS\d{17}$/;
const SUB_ORDER_NO_PATTERN = /^DS\d{17}-\d{2}$/;
const AFTERSALE_NO_PATTERN = /^AS\d{11}$/;

/** `YYYYMMDDHHmmss`（UTC+8 墙上时间）→ UTC Date。非法日期返回 null。 */
function parseShiftedTimestamp(wall) {
  if (!/^\d{14}$/.test(wall)) return null;
  const year = Number(wall.slice(0, 4));
  const month = Number(wall.slice(4, 6));
  const day = Number(wall.slice(6, 8));
  const hour = Number(wall.slice(8, 10));
  const minute = Number(wall.slice(10, 12));
  const second = Number(wall.slice(12, 14));
  const wallMs = Date.UTC(year, month - 1, day, hour, minute, second);
  if (Number.isNaN(wallMs)) return null;
  const c = new Date(wallMs);
  if (
    c.getUTCFullYear() !== year || c.getUTCMonth() !== month - 1 || c.getUTCDate() !== day ||
    c.getUTCHours() !== hour || c.getUTCMinutes() !== minute || c.getUTCSeconds() !== second
  ) {
    return null;
  }
  return new Date(wallMs - ID_TIMESTAMP_OFFSET_MINUTES * 60_000);
}

/** 主单号内嵌时间戳 → UTC Date（`DS20260920143000123` → 2026-09-20T06:30:00.000Z）。 */
function parseOrderNoTimestamp(orderNo) {
  if (!ORDER_NO_PATTERN.test(orderNo)) return null;
  return parseShiftedTimestamp(orderNo.slice(2, 16));
}

/** 售后单号内嵌日期 → 当日 `00:00:00`（UTC+8）对应的 UTC Date。 */
function parseAftersaleNoDate(aftersaleNo) {
  if (!AFTERSALE_NO_PATTERN.test(aftersaleNo)) return null;
  return parseShiftedTimestamp(`${aftersaleNo.slice(2, 10)}000000`);
}

/** 反向格式化（UTC → 单号内嵌 UTC+8 墙钟串），用于报错信息。 */
function toShiftedWall(date) {
  const s = new Date(date.getTime() + ID_TIMESTAMP_OFFSET_MINUTES * 60_000);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(s.getUTCFullYear(), 4)}${p(s.getUTCMonth() + 1)}${p(s.getUTCDate())}` +
    `${p(s.getUTCHours())}${p(s.getUTCMinutes())}${p(s.getUTCSeconds())}`;
}

function withinSeconds(actualIso, expectedDate, toleranceSeconds) {
  const actual = new Date(actualIso);
  if (Number.isNaN(actual.getTime())) return { ok: false, reason: `无法解析时间 ${actualIso}` };
  const deltaMs = Math.abs(actual.getTime() - expectedDate.getTime());
  return {
    ok: deltaMs <= toleranceSeconds * 1000,
    deltaMs,
    reason: `实际 ${actualIso} / 期望（UTC）${expectedDate.toISOString()}（差 ${deltaMs / 1000}s）`,
  };
}

/* -------------------------------------------------------------------------- */
/* 载入数据                                                                    */
/* -------------------------------------------------------------------------- */

const load = (file) => JSON.parse(readFileSync(path.join(DIR, file), "utf8"));

const products = load("products.json");
const attrs = load("product_attrs.json");
const policies = load("aftersale_policies.json");
const orders = load("orders.json");
const aftersales = load("aftersales.json");
const users = load("users.json");
const sql = readFileSync(path.join(DIR, "seed_cs.sql"), "utf8");

const PRO_SPU = "01J9Z8K2M4N5P6Q7R8S9T0V1W2";
const LITE_SPU = "01J9Z8K2M4N5P6Q7R8S9T0V1X1";

console.log("== seed-cs verify ==");
console.log(
  `  数据量：products=${products.length} attrs=${attrs.length} policies=${policies.length} ` +
  `orders=${orders.length} aftersales=${aftersales.length} users=${users.length}`,
);

/* -------------------------------------------------------------------------- */
/* 1. 单号格式                                                                  */
/* -------------------------------------------------------------------------- */

console.log("\n[1] 单号格式");

check("所有 order_no 匹配 /^DS\\d{17}$/", () => {
  for (const o of orders) assert(ORDER_NO_PATTERN.test(o.order_no), `非法 order_no：${o.order_no}`);
  return `${orders.length} 条`;
});

check("所有 sub_order_no 匹配 /^DS\\d{17}-\\d{2}$/", () => {
  let n = 0;
  for (const o of orders) {
    for (const s of o.sub_orders) {
      assert(SUB_ORDER_NO_PATTERN.test(s.sub_order_no), `非法 sub_order_no：${s.sub_order_no}`);
      assert(
        s.sub_order_no.startsWith(`${o.order_no}-`),
        `子单号 ${s.sub_order_no} 不属于主单 ${o.order_no}`,
      );
      n += 1;
    }
  }
  return `${n} 条`;
});

check("所有 aftersale_no 匹配 /^AS\\d{11}$/", () => {
  for (const a of aftersales) assert(AFTERSALE_NO_PATTERN.test(a.aftersale_no), `非法 aftersale_no：${a.aftersale_no}`);
  return `${aftersales.length} 条`;
});

/* -------------------------------------------------------------------------- */
/* 2. 单号内嵌时间戳（UTC+8）⇔ created_at（UTC）                                */
/* -------------------------------------------------------------------------- */

console.log("\n[2] 单号内嵌时间戳（UTC+8）⇔ created_at（UTC），容差 1s");

check("所有 order_no 内嵌时间戳与 orders.created_at 一致", () => {
  for (const o of orders) {
    const ts = parseOrderNoTimestamp(o.order_no);
    assert(ts !== null, `无法解析 order_no 时间戳：${o.order_no}`);
    const r = withinSeconds(o.created_at, ts, 1);
    assert(r.ok, `${o.order_no}：${r.reason}`);
  }
  return orders.map((o) => `${o.order_no}⇔${o.created_at}`).join(" ");
});

check("所有 sub_order_no 内嵌时间戳与所属主单 created_at 一致", () => {
  for (const o of orders) {
    const ts = parseOrderNoTimestamp(o.order_no);
    for (const s of o.sub_orders) {
      const sub = parseOrderNoTimestamp(s.sub_order_no.slice(0, 19));
      assert(sub !== null, `无法解析子单号时间戳：${s.sub_order_no}`);
      assert(sub.getTime() === ts.getTime(), `子单号时间戳与主单不一致：${s.sub_order_no}`);
      const r = withinSeconds(s.created_at, sub, 1);
      assert(r.ok, `${s.sub_order_no}：${r.reason}`);
    }
  }
  return "ok";
});

check("所有 aftersale_no 内嵌日期（UTC+8 当日）与 aftersales.created_at 同属一天", () => {
  for (const a of aftersales) {
    const dayStart = parseAftersaleNoDate(a.aftersale_no);
    assert(dayStart !== null, `无法解析 aftersale_no 日期：${a.aftersale_no}`);
    const created = new Date(a.created_at);
    const wall = toShiftedWall(created).slice(0, 8);
    const embedded = a.aftersale_no.slice(2, 10);
    eq(wall, embedded, `${a.aftersale_no} 的 UTC+8 日期与 created_at 不一致`);
  }
  return aftersales.map((a) => `${a.aftersale_no}⇔${a.created_at}`).join(" ");
});

check("order_status_logs.occurred_at 与所属订单时间区间合理", () => {
  for (const o of orders) {
    const created = new Date(o.created_at).getTime();
    for (const l of o.order_status_logs) {
      const t = new Date(l.occurred_at).getTime();
      assert(!Number.isNaN(t), `非法 occurred_at：${l.occurred_at}`);
      assert(t >= created - 1000, `${o.order_no} 的日志 ${l.id} 早于下单时间`);
    }
  }
  return "ok";
});

check("aftersale_logs.occurred_at 递增", () => {
  for (const a of aftersales) {
    let prev = -Infinity;
    for (const l of a.aftersale_logs) {
      const t = new Date(l.occurred_at).getTime();
      assert(!Number.isNaN(t), `非法 occurred_at：${l.occurred_at}`);
      assert(t >= prev, `${a.aftersale_no} 的时间线非递增：${l.occurred_at}`);
      prev = t;
    }
  }
  return aftersales.map((a) => `${a.aftersale_no}:${a.aftersale_logs.length} 条`).join(" ");
});

/* -------------------------------------------------------------------------- */
/* 3. 枚举取值                                                                  */
/* -------------------------------------------------------------------------- */

console.log("\n[3] 枚举取值（enums.ts）");

const inSet = (list, value, label) =>
  assert(list.includes(value), `${label} 非法取值：${value}（合法：${list.join("/")}）`);

check("products.status ∈ PRODUCT_STATUS", () => {
  for (const p of products) inSet(ENUMS.productStatus, p.status, `products[${p.id}].status`);
  return products.map((p) => p.status).join(",");
});

check("product_skus.status ∈ SKU_STATUS", () => {
  let n = 0;
  for (const p of products) {
    for (const s of p.skus) { inSet(ENUMS.skuStatus, s.status, `skus[${s.sku_code}].status`); n += 1; }
  }
  return `${n} 条`;
});

check("orders.status ∈ ORDER_STATUS", () => {
  for (const o of orders) inSet(ENUMS.orderStatus, o.status, `orders[${o.order_no}].status`);
  return orders.map((o) => `${o.order_no}=${o.status}`).join(" ");
});

check("orders.channel ∈ ORDER_CHANNEL", () => {
  for (const o of orders) inSet(ENUMS.channel, o.channel, `orders[${o.order_no}].channel`);
  return orders.map((o) => o.channel).join(",");
});

check("sub_orders.status ∈ SUB_ORDER_STATUS", () => {
  for (const o of orders) {
    for (const s of o.sub_orders) inSet(ENUMS.subOrderStatus, s.status, `sub_orders[${s.sub_order_no}].status`);
  }
  return "ok";
});

check("主单状态与子单聚合规则一致（08 §8.3：先剔除 CANCELLED）", () => {
  for (const o of orders) {
    const live = o.sub_orders.filter((s) => s.status !== "CANCELLED");
    let expected;
    if (live.length === 0) expected = "CANCELLED";
    else if (live.every((s) => s.status === "PENDING_PAYMENT")) expected = "PENDING_PAYMENT";
    else if (live.every((s) => s.status === "COMPLETED")) expected = "COMPLETED";
    else if (live.every((s) => s.status === "SHIPPED" || s.status === "COMPLETED") &&
             live.some((s) => s.status === "SHIPPED")) expected = "SHIPPED";
    else expected = "PAID";
    eq(o.status, expected, `${o.order_no} 主单状态与子单聚合不符`);
  }
  return orders.map((o) => `${o.order_no}=${o.status}`).join(" ");
});

check("order_status_logs.kind ∈ {status, trace}", () => {
  for (const o of orders) {
    for (const l of o.order_status_logs) inSet(ENUMS.logKind, l.kind, `order_status_logs[${l.id}].kind`);
  }
  return "ok";
});

check("order_status_logs.actor_type ∈ {system,user,admin,merchant}", () => {
  for (const o of orders) {
    for (const l of o.order_status_logs) inSet(ENUMS.logActorType, l.actor_type, `order_status_logs[${l.id}].actor_type`);
  }
  return "ok";
});

check("aftersales.type / status ∈ 枚举", () => {
  for (const a of aftersales) {
    inSet(ENUMS.aftersaleType, a.type, `aftersales[${a.aftersale_no}].type`);
    inSet(ENUMS.aftersaleStatus, a.status, `aftersales[${a.aftersale_no}].status`);
  }
  return aftersales.map((a) => `${a.aftersale_no}=${a.type}/${a.status}`).join(" ");
});

check("aftersale_logs.to_status / from_status / actor_type ∈ 枚举", () => {
  for (const a of aftersales) {
    for (const l of a.aftersale_logs) {
      inSet(ENUMS.aftersaleStatus, l.to_status, `aftersale_logs[${l.id}].to_status`);
      if (l.from_status !== null) inSet(ENUMS.aftersaleStatus, l.from_status, `aftersale_logs[${l.id}].from_status`);
      inSet(ENUMS.aftersaleActor, l.actor_type, `aftersale_logs[${l.id}].actor_type`);
    }
  }
  return "ok";
});

check("aftersale_policies.category / status ∈ 枚举", () => {
  for (const p of policies) {
    inSet(ENUMS.policyCategory, p.category, `aftersale_policies[${p.id}].category`);
    inSet(ENUMS.policyStatus, p.status, `aftersale_policies[${p.id}].status`);
  }
  return policies.map((p) => p.category).join(",");
});

check("users.status ∈ USER_STATUS", () => {
  for (const u of users) inSet(ENUMS.userStatus, u.status, `users[${u.id}].status`);
  return users.map((u) => u.status).join(",");
});

/* -------------------------------------------------------------------------- */
/* 4. 场景③ 负面断言：不存在任何「心率」属性                                     */
/* -------------------------------------------------------------------------- */

console.log("\n[4] 场景③ 负面防御：商品属性中不存在「心率」");

check("product_attrs 的 attr_name / attr_value / group_name 均不含「心率」", () => {
  for (const a of attrs) {
    for (const field of ["group_name", "attr_name", "attr_value"]) {
      assert(
        !String(a[field]).includes("心率"),
        `发现心率相关属性：${a.id} ${field}=${a[field]}`,
      );
    }
  }
  return `${attrs.length} 条属性全部通过`;
});

check("products 的 title / subtitle / detail_html 不含「心率」", () => {
  for (const p of products) {
    for (const field of ["title", "subtitle", "detail_html"]) {
      assert(!String(p[field] ?? "").includes("心率"), `商品 ${p.id} 的 ${field} 含「心率」`);
    }
  }
  return "ok";
});

check("aftersale_policies 正文不含「心率」", () => {
  for (const p of policies) assert(!p.content.includes("心率"), `政策 ${p.id} 含「心率」`);
  return "ok";
});

/* -------------------------------------------------------------------------- */
/* 5. 场景① 支撑：Pro 的「防护等级」分组与关键边界属性                            */
/* -------------------------------------------------------------------------- */

console.log("\n[5] 场景① 支撑：Pro 的「防护等级」分组");

check("Pro 的属性分组中存在「防护等级」", () => {
  const groups = [...new Set(attrs.filter((a) => a.spu_id === PRO_SPU).map((a) => a.group_name))];
  assert(groups.includes("防护等级"), `Pro 分组为 ${groups.join("/")}，缺少「防护等级」`);
  return groups.join("/");
});

check("Pro「防护等级」含 防水等级=IPX5 与 充电仓防水等级=不防水（IPX0）", () => {
  const group = attrs.filter((a) => a.spu_id === PRO_SPU && a.group_name === "防护等级");
  const ipx5 = group.find((a) => a.attr_name === "防水等级");
  const caseAttr = group.find((a) => a.attr_name === "充电仓防水等级");
  assert(ipx5 && ipx5.attr_value === "IPX5", "缺少 防水等级=IPX5");
  assert(caseAttr && caseAttr.attr_value.includes("不防水"), "缺少 充电仓防水等级=不防水（IPX0）");
  const taboo = group.find((a) => a.attr_name === "使用禁忌");
  assert(taboo && taboo.attr_value.includes("游泳"), "缺少 使用禁忌（游泳）");
  return "IPX5 / 充电仓不防水（IPX0）/ 使用禁忌含「游泳」";
});

check("Pro 的「售后与保修」分组含 质保期=12 个月 与 保修范围=非人为损坏", () => {
  const group = attrs.filter((a) => a.spu_id === PRO_SPU && a.group_name === "售后与保修");
  const warranty = group.find((a) => a.attr_name === "质保期");
  const scope = group.find((a) => a.attr_name === "保修范围");
  assert(warranty && warranty.attr_value === "12", "缺少 质保期=12");
  assert(scope && scope.attr_value === "非人为损坏", "缺少 保修范围=非人为损坏");
  return "ok";
});

check("warranty 政策正文明确「人为损坏、进液/进水不在保修范围」", () => {
  const w = policies.find((p) => p.category === "warranty");
  assert(w, "缺少 category=warranty 的政策");
  assert(w.content.includes("人为损坏"), "warranty 正文未提「人为损坏」");
  assert(/进液|进水/.test(w.content), "warranty 正文未提「进液/进水」");
  assert(w.content.includes("不在保修范围"), "warranty 正文未明确「不在保修范围」");
  return `${w.title} v${w.version}`;
});

check("Lite 的属性分组中存在「防护等级」且含 IP67", () => {
  const group = attrs.filter((a) => a.spu_id === LITE_SPU && a.group_name === "防护等级");
  assert(group.length > 0, "Lite 缺少「防护等级」分组");
  assert(group.some((a) => a.attr_value.includes("IP67")), "Lite 缺少 IP67");
  return "ok";
});

check("必需分组齐备：防护等级/电池续航/连接方式/包装清单", () => {
  const groups = new Set(attrs.map((a) => a.group_name));
  for (const g of ["防护等级", "电池续航", "连接方式", "包装清单"]) {
    assert(groups.has(g), `缺少分组「${g}」`);
  }
  return [...groups].join("/");
});

check("product_attrs.sort_order 在每个 SPU 内连续（1..N）", () => {
  for (const spu of [PRO_SPU, LITE_SPU]) {
    const list = attrs.filter((a) => a.spu_id === spu).map((a) => a.sort_order).sort((x, y) => x - y);
    list.forEach((v, i) => eq(v, i + 1, `${spu} 的 sort_order 不连续`));
  }
  return "ok";
});

/* -------------------------------------------------------------------------- */
/* 6. 场景② 支撑：订单物流查询                                                    */
/* -------------------------------------------------------------------------- */

console.log("\n[6] 场景② 支撑：订单物流查询");

const SCENE2_ORDER = "DS20260920143000123";

check(`存在订单 ${SCENE2_ORDER} 且含 ≥2 个子单`, () => {
  const o = orders.find((x) => x.order_no === SCENE2_ORDER);
  assert(o, `缺少订单 ${SCENE2_ORDER}`);
  assert(o.sub_orders.length >= 2, `子单数 ${o.sub_orders.length} < 2`);
  return o.sub_orders.map((s) => s.sub_order_no).join(", ");
});

check(`${SCENE2_ORDER} 至少一个子单 SHIPPED 且带完整物流字段`, () => {
  const o = orders.find((x) => x.order_no === SCENE2_ORDER);
  const shipped = o.sub_orders.filter((s) => s.status === "SHIPPED");
  assert(shipped.length > 0, "无 SHIPPED 子单");
  for (const s of shipped) {
    assert(s.express_company, `${s.sub_order_no} 缺 express_company`);
    assert(s.express_company_code, `${s.sub_order_no} 缺 express_company_code`);
    assert(s.express_no, `${s.sub_order_no} 缺 express_no`);
    assert(s.shipped_at, `${s.sub_order_no} 缺 shipped_at`);
  }
  return shipped.map((s) => `${s.sub_order_no}:${s.express_company}/${s.express_no}`).join(" ");
});

check(`${SCENE2_ORDER} 有 ≥3 条 kind=trace 的物流轨迹且 occurred_at 递增`, () => {
  const o = orders.find((x) => x.order_no === SCENE2_ORDER);
  const traces = o.order_status_logs.filter((l) => l.kind === "trace");
  assert(traces.length >= 3, `trace 行数 ${traces.length} < 3`);
  let prev = -Infinity;
  for (const t of traces) {
    const ts = new Date(t.occurred_at).getTime();
    assert(ts >= prev, `trace 时间非递增：${t.occurred_at}`);
    assert(typeof t.remark === "string" && t.remark.length > 0, `trace ${t.id} 缺 remark`);
    assert(t.sub_order_id, `trace ${t.id} 缺 sub_order_id`);
    prev = ts;
  }
  return `${traces.length} 条轨迹`;
});

check(`${SCENE2_ORDER} 有 kind=status 的状态流转行`, () => {
  const o = orders.find((x) => x.order_no === SCENE2_ORDER);
  const st = o.order_status_logs.filter((l) => l.kind === "status");
  assert(st.length > 0, "无 status 行");
  assert(st.some((l) => l.to_status === "SHIPPED"), "无流转到 SHIPPED 的 status 行");
  return `${st.length} 条状态流转`;
});

check("三个订单覆盖 全COMPLETED / 含SHIPPED / 含CANCELLED 三个聚合分支", () => {
  const statuses = orders.map((o) => o.status);
  assert(statuses.includes("COMPLETED"), "缺少 COMPLETED 主单");
  assert(statuses.includes("SHIPPED"), "缺少 SHIPPED 主单");
  assert(orders.some((o) => o.sub_orders.some((s) => s.status === "CANCELLED")), "缺少 CANCELLED 子单");
  return statuses.join(",");
});

check("订单 user_id 均指向 users.json 中的会员", () => {
  const ids = new Set(users.map((u) => u.id));
  for (const o of orders) assert(ids.has(o.user_id), `${o.order_no} 的 user_id ${o.user_id} 不在 users.json`);
  return orders.map((o) => o.user_id).join(",");
});

/* -------------------------------------------------------------------------- */
/* 7. 售后单：timeline 唯一来源                                                  */
/* -------------------------------------------------------------------------- */

console.log("\n[7] 售后单与时间线");

check("每条售后单都有 ≥3 条 aftersale_logs 且 occurred_at 递增", () => {
  for (const a of aftersales) {
    assert(a.aftersale_logs.length >= 3, `${a.aftersale_no} 时间线仅 ${a.aftersale_logs.length} 条`);
    let prev = -Infinity;
    for (const l of a.aftersale_logs) {
      const t = new Date(l.occurred_at).getTime();
      assert(t >= prev, `${a.aftersale_no} 时间线非递增`);
      prev = t;
    }
  }
  return aftersales.map((a) => `${a.aftersale_no}:${a.aftersale_logs.length}`).join(" ");
});

check("存在 return_refund 且状态 ≥ WAIT_BUYER_RETURN 并带 return_address 的售后单", () => {
  const reached = ["WAIT_BUYER_RETURN", "BUYER_RETURNED", "MERCHANT_RECEIVED", "REFUNDING", "REFUNDED"];
  const found = aftersales.filter((a) => a.type === "return_refund" && reached.includes(a.status));
  assert(found.length > 0, "无满足条件的退货退款单");
  for (const a of found) assert(a.return_address, `${a.aftersale_no} 缺 return_address`);
  return found.map((a) => `${a.aftersale_no}=${a.status}`).join(" ");
});

check("售后单覆盖 ≥2 种不同 status", () => {
  const set = new Set(aftersales.map((a) => a.status));
  assert(set.size >= 2, `status 种类仅 ${set.size}`);
  return [...set].join(",");
});

check("售后单的 order_no / sub_order_no 指向 orders.json 中真实记录", () => {
  const map = new Map(orders.map((o) => [o.order_no, new Set(o.sub_orders.map((s) => s.sub_order_no))]));
  for (const a of aftersales) {
    assert(map.has(a.order_no), `${a.aftersale_no} 的 order_no ${a.order_no} 不存在`);
    assert(map.get(a.order_no).has(a.sub_order_no), `${a.aftersale_no} 的 sub_order_no 不存在`);
  }
  return "ok";
});

/* -------------------------------------------------------------------------- */
/* 8. 政策覆盖                                                                  */
/* -------------------------------------------------------------------------- */

console.log("\n[8] 售后政策");

check("政策覆盖 return/refund/exchange/freight/warranty 五类且均为 effective", () => {
  const cats = policies.map((p) => p.category);
  for (const c of ENUMS.policyCategory) assert(cats.includes(c), `缺少政策分类 ${c}`);
  for (const p of policies) eq(p.status, "effective", `${p.id} 状态非 effective`);
  return cats.join(",");
});

check("所有政策 version = 1.0.0、content 为 markdown、effective_from 为 UTC ISO", () => {
  for (const p of policies) {
    eq(p.version, "1.0.0", `${p.id} 版本`);
    assert(p.content.startsWith("##"), `${p.id} 正文不是 markdown`);
    assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(p.effective_from), `${p.id} effective_from 非 UTC ISO`);
  }
  return `${policies.length} 条`;
});

/* -------------------------------------------------------------------------- */
/* 9. 用户                                                                      */
/* -------------------------------------------------------------------------- */

console.log("\n[9] 会员");

check("3 个会员，手机号为合法 11 位且互不重复", () => {
  eq(users.length, 3, "会员数");
  const phones = new Set();
  for (const u of users) {
    assert(/^1\d{10}$/.test(u.phone), `${u.id} 手机号非法：${u.phone}`);
    assert(!phones.has(u.phone), `手机号重复：${u.phone}`);
    phones.add(u.phone);
    assert(typeof u.phone_hash === "string" && u.phone_hash.length > 0, `${u.id} 缺 phone_hash`);
  }
  return users.map((u) => `${u.nickname}=${u.phone}`).join(" ");
});

/* -------------------------------------------------------------------------- */
/* 10. seed_cs.sql                                                             */
/* -------------------------------------------------------------------------- */

console.log("\n[10] seed_cs.sql");

const stripComments = (s) => s.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
const sqlBody = stripComments(sql);

check("ON CONFLICT 次数 == INSERT INTO 次数", () => {
  const inserts = (sqlBody.match(/INSERT INTO/g) || []).length;
  const conflicts = (sqlBody.match(/ON CONFLICT/g) || []).length;
  eq(conflicts, inserts, "ON CONFLICT 与 INSERT INTO 数量不一致");
  assert(inserts > 0, "未发现 INSERT INTO");
  return `INSERT INTO=${inserts} / ON CONFLICT=${conflicts}`;
});

/**
 * 引号感知地把 SQL 按 `;` 切成语句。
 *
 * ★ **不能**直接用 `sqlBody.split(";")`：图片字段现在是 data URI，
 *   形如 `data:image/png;base64,...`——**里面自带 `;`**，盲切会把一条语句
 *   从中间劈开，导致两半的单引号计数都变成奇数，从而**误报**「单引号不配平」。
 *   实测复现：一条含 data URI 的 INSERT 会被切成 2 段、各含 1 个单引号。
 *
 * 规则：只在**不在字符串字面量内**时按 `;` 切分；`''` 是转义的单引号，
 * 成对出现时不改变「是否在字面量内」的状态。
 */
const splitStatements = (body) => {
  const out = [];
  let current = "";
  let inString = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === "'") {
      if (inString && body[i + 1] === "'") {
        current += "''";
        i += 1;
        continue;
      }
      inString = !inString;
      current += ch;
      continue;
    }
    if (ch === ";" && !inString) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) out.push(current);
  return out.filter((s) => s.trim().length > 0);
};

check("每条语句以 ; 结尾、单引号配平（'' 转义；引号感知切分）", () => {
  const statements = splitStatements(sqlBody);
  // 切分必须无损：重新拼接（补回分隔符）后应与原体一致（只差空白与末尾分号）。
  assert(
    statements.join(";").replace(/\s+/g, "") === sqlBody.replace(/\s+/g, "").replace(/;$/, ""),
    "引号感知切分丢失了内容",
  );
  for (const s of statements) {
    const single = (s.match(/'/g) || []).length;
    assert(single % 2 === 0, `语句单引号数量为奇数（${single}）：${s.trim().slice(0, 60)}…`);
  }
  assert(sql.trimEnd().endsWith(";"), "文件未以 ; 结尾");
  return `${statements.length} 条语句`;
});

check("SQL 覆盖全部必需表", () => {
  const required = [
    "merchants", "stores", "categories", "products", "product_skus", "product_attrs",
    "product_images", "orders", "sub_orders", "order_items", "order_status_logs",
    "aftersales", "aftersale_logs", "aftersale_policies", "users",
  ];
  for (const t of required) {
    assert(new RegExp(`INSERT INTO ${t} `).test(sqlBody), `缺少表 ${t} 的种子`);
  }
  return required.join(",");
});

check("SQL 冲突键与字段契约 §12 一致", () => {
  const expected = {
    merchants: "id", stores: "id", categories: "id", products: "id",
    product_skus: "sku_code", product_attrs: "id", product_images: "id",
    orders: "order_no", sub_orders: "sub_order_no", order_items: "id",
    order_status_logs: "id", aftersales: "aftersale_no", aftersale_logs: "id",
    aftersale_policies: "id", users: "phone_hash",
  };
  for (const [table, key] of Object.entries(expected)) {
    const re = new RegExp(`INSERT INTO ${table} \\([^)]*\\)[\\s\\S]*?ON CONFLICT\\(${key}\\)`);
    assert(re.test(sqlBody), `${table} 的冲突键不是 ${key}`);
  }
  return `${Object.keys(expected).length} 张表`;
});

check("SQL 中不出现「心率」", () => {
  assert(!sql.includes("心率"), "seed_cs.sql 含「心率」");
  return "ok";
});

check("SQL 头部声明为虚构客服场景数据集且不得进生产", () => {
  const head = sql.split("\n").slice(0, 30).join("\n");
  assert(head.includes("虚构"), "头部未声明「虚构」");
  assert(/不得.*生产|生产.*不得/.test(head), "头部未声明不得进生产");
  return "ok";
});

check("SQL 的 DS 单号内嵌时间戳与 orders.json 一致", () => {
  for (const o of orders) {
    assert(sqlBody.includes(`'${o.order_no}'`), `seed_cs.sql 缺少订单号 ${o.order_no}`);
    const ts = parseOrderNoTimestamp(o.order_no);
    assert(sqlBody.includes(`'${ts.toISOString()}'`), `seed_cs.sql 缺少 ${o.order_no} 对应的 UTC 时间 ${ts.toISOString()}`);
  }
  return orders.map((o) => `${o.order_no}⇔${parseOrderNoTimestamp(o.order_no).toISOString()}`).join(" ");
});
/* -------------------------------------------------------------------------- */
/* 11. 图片字段（脚本生成的真实 PNG data URI）                                   */
/* -------------------------------------------------------------------------- */

console.log("\n[11] 图片字段（脚本生成）");

/**
 * ★ 本数据集的图片**不是外链**，而是由 `scripts/lib/png-image.ts` 在构建期
 *   确定性生成的**真实 PNG 字节**，以 `data:image/png;base64,…` 形式写进原有
 *   TEXT 列（无需改表、无需新接口、无需 CSP）。
 *
 * JSON 里保存的是生成指令 `gen:png?hue=<0-359>&seed=<n>&size=<8-1024>`，
 * 由 `scripts/build-seed-sql.ts` 调 `expandGenDirective()` 展开为 data URI。
 * 因此 JSON 可读、体积小，SQL 里则是可直接被浏览器解码的真图。
 */
const GEN_PREFIX = "gen:png?";
/**
 * 解析指令为参数表。**顺序无关**（与 `scripts/lib/png-image.ts` 的
 * `expandGenDirective()` 同口径），因此 `gen:png?size=256&hue=1&seed=2` 也合法。
 * 非法（缺参数 / 多余参数 / 前导零 / 非十进制）返回 `null`，由调用方报错。
 */
function parseGenDirective(value) {
  if (!value.startsWith(GEN_PREFIX)) return null;
  const out = {};
  for (const pair of value.slice(GEN_PREFIX.length).split("&")) {
    const i = pair.indexOf("=");
    if (i <= 0) return null;
    const key = pair.slice(0, i);
    const raw = pair.slice(i + 1);
    if (!/^(0|[1-9]\d*)$/.test(raw)) return null; // 拒绝前导零
    if (key !== "hue" && key !== "seed" && key !== "size") return null;
    if (out[key] !== undefined) return null;
    out[key] = Number(raw);
  }
  if (out.hue === undefined || out.seed === undefined || out.size === undefined) return null;
  return out;
}

/** 约定的图片尺寸（与 docs/README 登记一致）。 */
const SIZE_PRODUCT_MAIN = 512;
const SIZE_GALLERY = 256;
const SIZE_AVATAR = 64;

/** 收集 JSON 中全部图片字段：[值, 期望边长, 定位描述]。 */
function collectImageFields() {
  const out = [];
  for (const p of products) {
    out.push([p.main_image, SIZE_PRODUCT_MAIN, `products[${p.id}].main_image`]);
    for (const img of p.images ?? []) {
      out.push([img.url, SIZE_GALLERY, `product_images[${img.id}].url`]);
    }
  }
  for (const u of users) {
    out.push([u.avatar_url, SIZE_AVATAR, `users[${u.id}].avatar_url`]);
  }
  for (const o of orders) {
    for (const it of o.order_items ?? []) {
      out.push([it.image, SIZE_GALLERY, `order_items[${it.id}].image`]);
    }
  }
  for (const a of aftersales) {
    (a.evidence_urls ?? []).forEach((url, i) => {
      out.push([url, SIZE_GALLERY, `aftersales[${a.aftersale_no}].evidence_urls[${i}]`]);
    });
  }
  return out;
}

const imageFields = collectImageFields();

check("JSON 的图片字段全部是 gen:png? 生成指令（不是外链）", () => {
  assert(imageFields.length > 0, "未收集到任何图片字段");
  for (const [value, , where] of imageFields) {
    assert(typeof value === "string" && value.length > 0, `${where} 为空或非字符串`);
    assert(value.startsWith(GEN_PREFIX), `${where} 不是生成指令：${String(value).slice(0, 60)}`);
  }
  return `${imageFields.length} 个字段`;
});

check("gen:png? 指令参数合法且边长符合约定", () => {
  for (const [value, expectedSize, where] of imageFields) {
    const p = parseGenDirective(value);
    assert(p, `${where} 指令格式非法：${value}`);
    assert(p.hue >= 0 && p.hue <= 359, `${where} hue 越界：${p.hue}`);
    assert(Number.isSafeInteger(p.seed) && p.seed >= 0, `${where} seed 非法：${p.seed}`);
    assert(p.size >= 8 && p.size <= 1024, `${where} size 越界：${p.size}`);
    eq(p.size, expectedSize, `${where} 的边长不符合约定`);
  }
  const sizes = {};
  for (const [value] of imageFields) {
    const p = parseGenDirective(value);
    sizes[p.size] = (sizes[p.size] ?? 0) + 1;
  }
  return `尺寸分布 ${Object.entries(sizes).map(([k, v]) => `${k}×${v}`).join(" / ")}`;
});

check("全部种子文件不出现 http(s) 外链或 img.dshop.example.com", () => {
  const files = [
    "products.json", "product_attrs.json", "aftersale_policies.json",
    "orders.json", "aftersales.json", "users.json", "seed_cs.sql",
  ];
  for (const f of files) {
    const text = f === "seed_cs.sql" ? sql : readFileSync(path.join(DIR, f), "utf8");
    assert(!/https?:\/\//.test(text), `${f} 含 http(s) 外链`);
    assert(!text.includes("img.dshop.example.com"), `${f} 含虚构图片域名`);
  }
  return files.length + " 个文件";
});

check("seed_cs.sql 的图片列全部是 data:image/png;base64, data URI", () => {
  const uris = sql.match(/data:image\/png;base64,[A-Za-z0-9+/=]+/g) ?? [];
  assert(uris.length > 0, "seed_cs.sql 中没有任何 data URI");
  // 商户 logo / 资质图来自 build-seed-sql.ts 的常量（不在 JSON 里），一并计入。
  const expected = imageFields.length + 2;
  eq(uris.length, expected, "data URI 数量与「JSON 指令数 + 商户常量 2」不符");
  return `${uris.length} 条`;
});

check("每条 data URI 都是可解码的真实 PNG，且 IHDR 边长与约定一致", () => {
  const uris = sql.match(/data:image\/png;base64,[A-Za-z0-9+/=]+/g) ?? [];
  const histogram = {};
  const seen = new Set();
  for (const uri of uris) {
    const b64 = uri.slice("data:image/png;base64,".length);
    const bytes = Buffer.from(b64, "base64");
    assert(bytes.length > 8, "PNG 字节过短");
    // PNG magic：89 50 4E 47 0D 0A 1A 0A
    const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    for (let i = 0; i < magic.length; i += 1) {
      assert(bytes[i] === magic[i], `PNG magic 不正确（第 ${i} 字节）`);
    }
    // IHDR 紧跟在 8 字节签名 + 4 字节长度 + 4 字节类型之后。
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    eq(width, height, "PNG 非正方形");
    assert([SIZE_AVATAR, SIZE_GALLERY, SIZE_PRODUCT_MAIN].includes(width), `PNG 边长异常：${width}`);
    histogram[width] = (histogram[width] ?? 0) + 1;
    seen.add(uri);
  }
  // 参数不同 ⇒ 图像必须不同（证明生成器真的受参数驱动，而非返回常量）。
  eq(seen.size, uris.length, "存在重复的 data URI（生成器可能忽略参数）");
  eq(histogram[SIZE_PRODUCT_MAIN], 2, "512×512 主图数量应为 2");
  eq(histogram[SIZE_AVATAR], 3, "64×64 头像数量应为 3");
  eq(histogram[SIZE_GALLERY], 17, "256×256 图片数量应为 17");
  return `64×${histogram[SIZE_AVATAR]} / 256×${histogram[SIZE_GALLERY]} / 512×${histogram[SIZE_PRODUCT_MAIN]}`;
});

/**
 * PNG 结构完整性：逐 chunk 重算 CRC32、要求有且仅有 1 个 IHDR/IDAT 段组、
 * 以 IEND 结尾，且 IDAT 能被 `zlib.inflateSync` 解压出**精确长度**的扫描线数据。
 *
 * 为什么需要它：上面那条只查 8 字节签名 + IHDR 宽高。若已提交的 `seed_cs.sql`
 * 被手工改动、或某次重新生成产出损坏的 IDAT（CRC 错 / Adler-32 错 / 截断 / 缺 IEND），
 * 签名与宽高仍然正确 —— 断言全绿，浏览器里却是破图。
 * 生成器内部的守卫只在**生成时**运行，对仓库里已落盘的 SQL 不生效。
 */
const PNG_CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function pngCrc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = PNG_CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 拆出全部 chunk：[{type, data}]；结构不合法即抛。 */
function parsePngChunks(bytes) {
  const chunks = [];
  let off = 8; // 跳过签名
  while (off < bytes.length) {
    assert(off + 8 <= bytes.length, "chunk 头被截断");
    const len = bytes.readUInt32BE(off);
    const type = bytes.toString("latin1", off + 4, off + 8);
    const dataStart = off + 8;
    assert(dataStart + len + 4 <= bytes.length, `chunk ${type} 数据被截断`);
    const data = bytes.subarray(dataStart, dataStart + len);
    const want = bytes.readUInt32BE(dataStart + len);
    const got = pngCrc32(bytes.subarray(off + 4, dataStart + len));
    eq(got, want, `chunk ${type} 的 CRC32 不匹配`);
    chunks.push({ type, data });
    off = dataStart + len + 4;
  }
  eq(off, bytes.length, "chunk 流长度与文件长度不一致");
  return chunks;
}

check("每条 data URI 的 PNG 结构完整（CRC32 / IDAT 可解压 / 以 IEND 收尾）", () => {
  const uris = sql.match(/data:image\/png;base64,[A-Za-z0-9+/=]+/g) ?? [];
  assert(uris.length > 0, "没有 data URI 可校验");
  for (const uri of uris) {
    const bytes = Buffer.from(uri.slice("data:image/png;base64,".length), "base64");
    const chunks = parsePngChunks(bytes);
    const types = chunks.map((c) => c.type);
    eq(types[0], "IHDR", "首个 chunk 不是 IHDR");
    eq(types[types.length - 1], "IEND", "末个 chunk 不是 IEND");
    eq(chunks[chunks.length - 1].data.length, 0, "IEND 数据长度非 0");
    eq(types.filter((t) => t === "IHDR").length, 1, "IHDR 数量不为 1");
    eq(types.filter((t) => t === "IEND").length, 1, "IEND 数量不为 1");
    assert(types.includes("IDAT"), "缺少 IDAT");
    // 色深 8 / 真彩色（type 2）→ 每像素 3 字节；每行前置 1 字节 filter。
    const ihdr = chunks[0].data;
    const width = ihdr.readUInt32BE(0);
    const height = ihdr.readUInt32BE(4);
    eq(ihdr[8], 8, "bit depth 不是 8");
    eq(ihdr[9], 2, "color type 不是 2（truecolor）");
    const raw = zlib.inflateSync(Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data)));
    eq(raw.length, height * (1 + 3 * width), "解压后的扫描线长度不符");
    // 每行 filter 字节必须是 0（None）—— 与生成器一致。
    for (let y = 0; y < height; y += 1) {
      eq(raw[y * (1 + 3 * width)], 0, `第 ${y} 行的 filter 字节非 0`);
    }
  }
  return `${uris.length} 条全部通过`;
});

check("seed_cs.sql 中不存在未展开的 gen:png? 指令", () => {
  // 若 JSON 改了却忘记重新生成 SQL，或有人手工编辑 SQL，这里会立刻暴露。
  assert(!sql.includes(GEN_PREFIX), "seed_cs.sql 含未展开的 gen:png? 指令（请重新运行 npm run seed:sql）");
  return "ok";
});

check("seed_cs.sql 与 JSON 的图片指令一一对应（改了 JSON 必须重新生成 SQL）", () => {
  // 上面两条只能保证「SQL 里的图是好的」，不能保证「SQL 里的图就是当前 JSON 要的图」。
  // 这条把两侧接上：JSON 每条指令的期望边长，必须在 SQL 的尺寸直方图里有对应计数。
  const uris = sql.match(/data:image\/png;base64,[A-Za-z0-9+/=]+/g) ?? [];
  const histogram = {};
  for (const uri of uris) {
    const bytes = Buffer.from(uri.slice("data:image/png;base64,".length), "base64");
    const w = bytes.readUInt32BE(16);
    histogram[w] = (histogram[w] ?? 0) + 1;
  }
  const want = {};
  for (const [, size] of imageFields) want[size] = (want[size] ?? 0) + 1;
  want[SIZE_GALLERY] = (want[SIZE_GALLERY] ?? 0) + 2; // 商户 logo + 资质图（脚本内常量）
  for (const [size, n] of Object.entries(want)) {
    eq(histogram[size] ?? 0, n, `SQL 中 ${size}×${size} 的图片数量与 JSON 不符（SQL 可能未重新生成）`);
  }
  return Object.entries(want).map(([k, v]) => `${k}×${v}`).join(" / ");
});


/* -------------------------------------------------------------------------- */
/* 汇总                                                                        */
/* -------------------------------------------------------------------------- */

console.log(`\n== 结果：${passed} 通过 / ${failures.length} 失败 ==`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
console.log("ALL GREEN");
