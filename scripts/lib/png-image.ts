/**
 * scripts/lib/png-image.ts —— 零依赖、确定性的 PNG 生成器。
 *
 * 背景：`data/seed-cs/*.json` 里原先的图片地址是**虚构域** `img.dshop.example.com`，
 * 浏览器里全是裂图。现在改为由本模块现场生成**真实 PNG 字节**并以 data URI 入库。
 *
 * 硬约束（不得破坏）：
 *   1. **零 npm 依赖**：只用 `node:zlib` 内置模块。
 *   2. **确定性**：同 `(size, hue, seed)` 必须产出**字节级一致**的 PNG。
 *      不使用 `Math.random()`、不使用 `new Date()`。
 *
 * PNG 结构（RFC 2083）：
 *   8 字节签名 `89 50 4E 47 0D 0A 1A 0A`
 *   + 若干 chunk，每个 chunk = `[长度 4][类型 4][数据][CRC32 4]`（CRC 覆盖「类型 + 数据」）：
 *     - `IHDR`：宽高各 4 字节大端、bit depth = 8、color type = **2（truecolor RGB）**
 *     - `IDAT`：**zlib 流**（0x78 头 + deflate 数据 + Adler-32 大端），
 *               解压后 = 每行「1 字节 filter 类型（0 = None）+ width*3 字节 RGB」
 *     - `IEND`：空
 *
 * 为何**手写 base64**（而不用 `Buffer.toString("base64")`）：
 *   `tooling/tsconfig/base.json` 的 `types` 含 `@cloudflare/workers-types`，
 *   它声明的全局 `Buffer` 把 `toString` 收窄成无参重载，
 *   于是 `Buffer.toString("base64")` 会报 `TS2554: Expected 0 arguments, but got 1`。
 *   手写 base64 同时也让本模块不依赖任何 Node Buffer 语义。
 */

import { deflateSync } from "node:zlib";

/* -------------------------------------------------------------------------- */
/* CRC32 / Adler32（PNG 与 zlib 校验和，手写以避免额外依赖）                      */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]!)! & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    a = (a + bytes[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** 拼一个 PNG chunk：`[长度][类型][数据][CRC32(类型+数据)]`。 */
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * 把裸像素数据压成 PNG 的 `IDAT` 载荷 —— 即一条完整 **zlib 流**
 * （`0x78` 头 + deflate 数据 + Adler-32 大端）。
 *
 * `node:zlib` 的 `deflateSync` 产出的正是完整 zlib 流（实测对同一输入**确定性**），
 * 因此直接复用；这里额外校验头字节与 Adler-32 尾校验和，
 * 一旦 Node 行为变化（非 zlib 流 / 校验和不符）立即**抛错**，不产出坏 PNG。
 */
function zlibStream(raw: Uint8Array): Uint8Array {
  const stream = new Uint8Array(deflateSync(raw));
  if (stream.length < 6 || stream[0] !== 0x78) {
    throw new Error(`deflateSync 未产出 zlib 流（首字节 ${String(stream[0])}）`);
  }
  const p = stream.length - 4;
  const actual =
    ((stream[p]! << 24) | (stream[p + 1]! << 16) | (stream[p + 2]! << 8) | stream[p + 3]!) >>> 0;
  const expected = adler32(raw);
  if (actual !== expected) {
    throw new Error(`zlib 流 Adler-32 校验失败：期望 ${expected}，实际 ${actual}`);
  }
  return stream;
}

/* -------------------------------------------------------------------------- */
/* base64（手写，见文件头注释「为何手写 base64」）                                */
/* -------------------------------------------------------------------------- */

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : undefined;
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? "=" : B64[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? "=" : B64[b2 & 63];
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* 图案：由 hue + seed 决定的确定性「商品图」                                    */
/* -------------------------------------------------------------------------- */

/** HSV → RGB（h ∈ [0,360)，s/v ∈ [0,1]），返回 0–255 整数三元组。 */
function hsvToRgb(h: number, s: number, v: number): readonly [number, number, number] {
  const c = v * s;
  const hp = (h % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = v - c;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/**
 * 画一张 `size×size` 的图：对角渐变底 + 居中圆角方块 + 纵向明暗。
 *
 * `seed` 只参与**确定性**的相位/条纹偏移（不使用随机源），
 * 用来让同一商品的多张图**肉眼可区分**。
 */
function drawImage(size: number, hue: number, seed: number): Uint8Array {
  const rgb = new Uint8Array(size * size * 3);
  const [br, bg, bb] = hsvToRgb(hue, 0.35, 0.95);
  const [fr, fg, fb] = hsvToRgb(hue, 0.75, 0.75);
  const [hr, hg, hb] = hsvToRgb(hue, 0.15, 1.0);
  const pad = Math.round(size * 0.22);
  const radius = Math.round(size * 0.12);
  // seed 派生：对角相位偏移 + 条纹周期（均为确定性整数运算）。
  const phase = ((seed * 29) % 97) / 97; // ∈ [0,1)
  const stripePeriod = (1 + (seed % 3)) * 2; // ∈ {2,4,6}
  const stripeWidth = Math.max(1, Math.round(size / 16));

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const t = Math.min(1, Math.max(0, (x + y) / (2 * size) + (phase - 0.5) * 0.4));
      let cr = Math.round(br + (hr - br) * t);
      let cg = Math.round(bg + (hg - bg) * t);
      let cb = Math.round(bb + (hb - bb) * t);

      const inX = x >= pad && x < size - pad;
      const inY = y >= pad && y < size - pad;
      if (inX && inY) {
        const dx = Math.min(x - pad, size - pad - 1 - x);
        const dy = Math.min(y - pad, size - pad - 1 - y);
        const inSquare =
          dx >= radius || dy >= radius || (dx - radius) ** 2 + (dy - radius) ** 2 <= radius * radius;
        if (inSquare) {
          const shade = 0.75 + 0.25 * (1 - y / size);
          // seed 条纹：只轻微扰动明暗，保证「同 seed 同图、异 seed 异图」。
          const stripe = Math.floor((x + y) / stripeWidth) % stripePeriod === 0 ? 0.94 : 1;
          cr = Math.round(fr * shade * stripe);
          cg = Math.round(fg * shade * stripe);
          cb = Math.round(fb * shade * stripe);
        }
      }

      const o = (y * size + x) * 3;
      rgb[o] = cr;
      rgb[o + 1] = cg;
      rgb[o + 2] = cb;
    }
  }
  return rgb;
}

/* -------------------------------------------------------------------------- */
/* 参数校验与对外 API                                                          */
/* -------------------------------------------------------------------------- */

/** 生成指令前缀：`gen:png?hue=210&seed=1&size=512`。 */
export const GEN_DIRECTIVE_PREFIX = "gen:png?";

const SIZE_MIN = 8;
const SIZE_MAX = 1024;

function assertInt(value: number, min: number, max: number, label: string): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} 必须是 ${min}–${max} 的整数，收到 ${String(value)}`);
  }
}

/** 严格校验（非法即抛，不静默回落）。 */
function assertGenParams(size: number, hue: number, seed: number): void {
  assertInt(size, SIZE_MIN, SIZE_MAX, "gen:png size");
  assertInt(hue, 0, 359, "gen:png hue");
  assertInt(seed, 0, Number.MAX_SAFE_INTEGER, "gen:png seed");
}

/** 生成 `size×size` 的 PNG 字节（真实、可被浏览器解码、确定性）。 */
export function renderPng(size: number, hue: number, seed: number): Uint8Array {
  assertGenParams(size, hue, seed);
  const stride = size * 3;
  const raw = new Uint8Array(size * (1 + stride));
  const rgb = drawImage(size, hue, seed);
  for (let y = 0; y < size; y += 1) {
    raw[y * (1 + stride)] = 0; // filter 类型 0 = None
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (1 + stride) + 1);
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, size); // width（大端）
  view.setUint32(4, size); // height（大端）
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type = truecolor RGB
  // 10..12 = compression / filter / interlace，全 0

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlibStream(raw)),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** 生成 `data:image/png;base64,...`（可直接写进 D1 的 TEXT 列）。 */
export function pngDataUri(size: number, hue: number, seed: number): string {
  return `data:image/png;base64,${base64(renderPng(size, hue, seed))}`;
}

/**
 * 把生成指令 `gen:png?hue=<0-359>&seed=<非负整数>&size=<8-1024>` 展开为 data URI。
 *
 * **不是**该前缀的字符串**原样返回**（这样非图片字段不会受影响）。
 * 参数缺失或非法一律 `throw`（本项目纪律：失败要响，不静默回落）。
 */
export function expandGenDirective(value: string): string {
  if (!value.startsWith(GEN_DIRECTIVE_PREFIX)) return value;

  const query = value.slice(GEN_DIRECTIVE_PREFIX.length);
  const parsed = new Map<string, string>();
  for (const pair of query.split("&")) {
    if (pair === "") throw new Error(`gen:png 指令含空参数：${value}`);
    const index = pair.indexOf("=");
    if (index <= 0) throw new Error(`gen:png 参数缺少 '='：${value}`);
    const key = pair.slice(0, index);
    const raw = pair.slice(index + 1);
    // 拒绝前导零（`007`）：否则 `hue=007` 与 `hue=7` 是两条不同指令却产出同一张图，
    // 会让「指令 ↔ 图像」不再一一对应。
    if (!/^(0|[1-9]\d*)$/.test(raw)) {
      throw new Error(`gen:png 参数 ${key} 必须是非负十进制整数（不允许前导零），收到 "${raw}"`);
    }
    if (parsed.has(key)) throw new Error(`gen:png 参数 ${key} 重复：${value}`);
    parsed.set(key, raw);
  }

  const known = ["hue", "seed", "size"] as const;
  for (const key of parsed.keys()) {
    if (!known.includes(key as (typeof known)[number])) {
      throw new Error(`gen:png 未知参数 ${key}：${value}`);
    }
  }
  for (const key of known) {
    if (!parsed.has(key)) throw new Error(`gen:png 缺少参数 ${key}：${value}`);
  }

  const size = Number(parsed.get("size"));
  const hue = Number(parsed.get("hue"));
  const seed = Number(parsed.get("seed"));
  assertGenParams(size, hue, seed);
  return pngDataUri(size, hue, seed);
}
