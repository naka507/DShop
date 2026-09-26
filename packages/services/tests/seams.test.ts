/**
 * 升级缝适配器测试（`docs/04` §4.3、`docs/12` §12.9.4、§12.15）。
 *
 * 覆盖三类断言：
 * 1. **绑定切换语义**——缺绑定 → 默认实现；加绑定 → 升级实现；删绑定 → 回到默认实现；
 * 2. **S1 负向控制**——`enqueue` 必须 `await` D1 写入（未 await 会静默丢任务）；
 * 3. **接口一致性**——两个实现可互换地赋给同一接口变量。
 */

import { describe, expect, it } from "vitest";

import { getCachePort, KvCachePort, NoopCachePort } from "../src/cache-port.js";
import { getMediaPort, MEDIA_PUBLIC_HOST, NoopMediaPort, R2MediaPort } from "../src/media.js";
import {
  DEFAULT_PAGE_SIZE,
  D1LikeProductSearch,
  escapeLikePattern,
  getProductSearch,
  tokenize,
  VectorizeProductSearch,
} from "../src/product-search.js";
import type { ProductSearchPort } from "../src/product-search.js";
import { getReadDb, getReadDrizzle } from "../src/read-db.js";
import { D1TaskQueue, getTaskQueue, QueuesTaskQueue, TASK_TYPE } from "../src/task-queue.js";
import type { TaskQueue } from "../src/task-queue.js";

/* -------------------------------------------------------------------------- */
/* 假绑定（结构化最小实现，绝不 import 真实运行时）                               */
/* -------------------------------------------------------------------------- */

/** 可控的 D1 写入闸门：`run()` 只有被 `release()` 放行后才落定。 */
interface FakeDb {
  readonly db: D1Database;
  readonly calls: string[];
  release(): void;
}

function makeFakeDb(): FakeDb {
  const calls: string[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const statement = {
    bind(...values: unknown[]) {
      calls.push(`bind:${values.length}`);
      return {
        run: async () => {
          await gate;
          calls.push("run");
          return { success: true };
        },
        first: async () => null,
        all: async () => ({ results: [] }),
      };
    },
  };

  const db = {
    prepare(sql: string) {
      calls.push(`prepare:${sql}`);
      return statement;
    },
  };

  return { db: db as unknown as D1Database, calls, release: () => release() };
}

/** 假 Queues：记录 `send` 的消息体。 */
function makeFakeQueue(): { queue: Queue; sent: unknown[] } {
  const sent: unknown[] = [];
  const queue = {
    send: async (message: unknown) => {
      sent.push(message);
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
  };
  return { queue: queue as unknown as Queue, sent };
}

/** 假 KV：内存 Map，记录写入次数。 */
function makeFakeKv(): { kv: KVNamespace; store: Map<string, string> } {
  const store = new Map<string, string>();
  const kv = {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
  };
  return { kv: kv as unknown as KVNamespace, store };
}

/** 假 R2 桶：绑定本身不提供签名能力，只需是一个对象即可。 */
const fakeBucket = {} as unknown as R2Bucket;

/** 假 Vectorize 索引：只实现用到的 `query` 子集。 */
const fakeVectorIndex = {
  query: async () => ({ matches: [], count: 0 }),
} as unknown as VectorizeIndex;

/* -------------------------------------------------------------------------- */
/* S1 异步任务缝                                                                */
/* -------------------------------------------------------------------------- */

describe("S1 异步任务缝（docs/04 §4.3 S1）", () => {
  it("缺绑定（键不存在）→ D1TaskQueue", () => {
    const fake = makeFakeDb();
    const queue = getTaskQueue({ DB: fake.db });
    expect(queue).toBeInstanceOf(D1TaskQueue);
  });

  it("缺绑定（键存在但值为 undefined）→ 仍回落到 D1TaskQueue", () => {
    const fake = makeFakeDb();
    const queue = getTaskQueue({ DB: fake.db, TASK_QUEUE: undefined });
    expect(queue).toBeInstanceOf(D1TaskQueue);
  });

  it("加绑定 → QueuesTaskQueue", () => {
    const fake = makeFakeDb();
    const { queue: binding } = makeFakeQueue();
    const queue = getTaskQueue({ DB: fake.db, TASK_QUEUE: binding });
    expect(queue).toBeInstanceOf(QueuesTaskQueue);
  });

  it("删绑定 → 回到 D1TaskQueue（即刻回滚，无需改代码）", () => {
    const fake = makeFakeDb();
    const { queue: binding } = makeFakeQueue();
    const upgraded: { DB: D1Database; TASK_QUEUE?: Queue } = {
      DB: fake.db,
      TASK_QUEUE: binding,
    };
    expect(getTaskQueue(upgraded)).toBeInstanceOf(QueuesTaskQueue);

    delete upgraded.TASK_QUEUE;
    expect(getTaskQueue(upgraded)).toBeInstanceOf(D1TaskQueue);
  });

  it("负向控制：enqueue 必须 await D1 写入（未 await 则任务静默丢失）", async () => {
    const fake = makeFakeDb();
    const queue = new D1TaskQueue(fake.db);

    let settled = false;
    const pending = queue.enqueue(TASK_TYPE.NOTIFY_SEND, { orderNo: "DS1" }).then(() => {
      settled = true;
    });

    // 冲掉微任务队列：若实现未 await，`pending` 此时早已落定。
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    // 放行 D1 写入后才应落定——证明 enqueue 卡在写入上。
    fake.release();
    await pending;
    expect(settled).toBe(true);
    expect(fake.calls).toContain("run");
  });

  it("D1TaskQueue 写入 task_queue 且带上 attempts=0 / status='pending'", async () => {
    const fake = makeFakeDb();
    const queue = new D1TaskQueue(fake.db);
    fake.release();
    await queue.enqueue(TASK_TYPE.COUPON_EXPIRE, { batch: 1 });

    const insert = fake.calls.find((call) => call.startsWith("prepare:INSERT INTO task_queue"));
    expect(insert).toBeDefined();
    expect(insert).toContain("status, attempts, run_at");
    expect(insert).toContain("'pending', 0");
  });

  it("QueuesTaskQueue 发送 { type, payload } 消息体", async () => {
    const { queue, sent } = makeFakeQueue();
    await new QueuesTaskQueue(queue).enqueue(TASK_TYPE.ORDER_AUTO_CONFIRM, { orderNo: "DS2" });
    expect(sent).toEqual([{ type: "order.auto_confirm", payload: { orderNo: "DS2" } }]);
  });

  it("两个实现同接口（类型层面）", () => {
    const fake = makeFakeDb();
    const { queue: binding } = makeFakeQueue();
    const implementations: TaskQueue[] = [new D1TaskQueue(fake.db), new QueuesTaskQueue(binding)];
    expect(implementations).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/* S5 搜索缝                                                                    */
/* -------------------------------------------------------------------------- */

describe("S5 搜索缝（docs/04 §4.3 S5）", () => {
  it("缺绑定 → D1LikeProductSearch；加绑定 → VectorizeProductSearch；删绑定 → 回落", () => {
    const fake = makeFakeDb();
    const env: { DB: D1Database; PRODUCT_SEARCH?: VectorizeIndex } = { DB: fake.db };
    expect(getProductSearch(env)).toBeInstanceOf(D1LikeProductSearch);

    env.PRODUCT_SEARCH = fakeVectorIndex;
    expect(getProductSearch(env)).toBeInstanceOf(VectorizeProductSearch);

    delete env.PRODUCT_SEARCH;
    expect(getProductSearch(env)).toBeInstanceOf(D1LikeProductSearch);
  });

  it("键存在但值为 undefined → 仍回落到默认实现", () => {
    const fake = makeFakeDb();
    expect(getProductSearch({ DB: fake.db, PRODUCT_SEARCH: undefined })).toBeInstanceOf(
      D1LikeProductSearch,
    );
  });

  it("两个实现同接口（类型层面，可直接互换赋值）", () => {
    const fake = makeFakeDb();
    const d1: ProductSearchPort = new D1LikeProductSearch(fake.db);
    const vector: ProductSearchPort = new VectorizeProductSearch(fakeVectorIndex);
    expect([d1, vector]).toHaveLength(2);
  });

  it("分词：按标点切分、去重、截断", () => {
    expect(tokenize("真无线 耳机,蓝牙")).toEqual(["真无线", "耳机", "蓝牙"]);
    expect(tokenize("a a a")).toEqual(["a"]);
    expect(tokenize(undefined)).toEqual([]);
  });

  it("LIKE 通配符被转义（% / _ 不当通配）", () => {
    expect(escapeLikePattern("50%_off")).toBe("50\\%\\_off");
  });

  it("默认实现：无关键词 + 非正整数分页 → 只按上架过滤，回落默认页大小", async () => {
    const fake = makeFakeDb();
    const search = new D1LikeProductSearch(fake.db);
    await search.search({ page: 0, pageSize: -3 });

    const count = fake.calls.find((call) => call.startsWith("prepare:SELECT COUNT(*)"));
    expect(count).toBeDefined();
    expect(count).toContain("status = ?");
    expect(count).not.toContain("LIKE");
    // status 上架 + pageSize + offset = 3 个绑定
    expect(fake.calls).toContain("bind:3");
    expect(DEFAULT_PAGE_SIZE).toBe(20);
  });

  it("升级实现：无关键词时不做无意义的向量召回", async () => {
    const search = new VectorizeProductSearch(fakeVectorIndex);
    await expect(search.search({ page: 1, pageSize: 10 })).resolves.toEqual({
      ids: [],
      total: 0,
    });
  });

  it("升级实现：缺嵌入函数时显式抛错（不静默返回空结果）", async () => {
    const search = new VectorizeProductSearch(fakeVectorIndex);
    await expect(search.search({ q: "耳机", page: 1, pageSize: 10 })).rejects.toThrow(/嵌入函数/u);
  });
});

/* -------------------------------------------------------------------------- */
/* S2 数据库读扩展缝                                                            */
/* -------------------------------------------------------------------------- */

describe("S2 数据库读扩展缝（docs/04 §4.3 S2）", () => {
  it("缺绑定 → 主库；加绑定 → 只读副本；删绑定 → 回主库", () => {
    const primary = makeFakeDb().db;
    const replica = makeFakeDb().db;

    const env: { DB: D1Database; READ_DB?: D1Database } = { DB: primary };
    expect(getReadDb(env)).toBe(primary);

    env.READ_DB = replica;
    expect(getReadDb(env)).toBe(replica);

    delete env.READ_DB;
    expect(getReadDb(env)).toBe(primary);
  });

  it("键存在但值为 undefined → 回退主库", () => {
    const primary = makeFakeDb().db;
    expect(getReadDb({ DB: primary, READ_DB: undefined })).toBe(primary);
  });

  it("getReadDrizzle 返回 Drizzle 实例（走读连接，不抛错）", () => {
    const primary = makeFakeDb().db;
    const replica = makeFakeDb().db;
    expect(getReadDrizzle({ DB: primary })).toBeDefined();
    expect(getReadDrizzle({ DB: primary, READ_DB: replica })).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* S7 缓存叠加缝                                                                */
/* -------------------------------------------------------------------------- */

describe("S7 缓存叠加缝（docs/04 §4.3 S7：叠加而非切换）", () => {
  it("缺绑定 → NoopCachePort（不叠加，默认不引入 KV 层）", async () => {
    const port = getCachePort({});
    expect(port).toBeInstanceOf(NoopCachePort);
    expect(await port.get("k")).toBeNull();
    await port.put("k", "v", 60);
    expect(await port.get("k")).toBeNull();
  });

  it("加绑定 → KvCachePort；删绑定 → 回到 Noop", () => {
    const { kv } = makeFakeKv();
    const env: { CACHE_KV?: KVNamespace } = {};
    expect(getCachePort(env)).toBeInstanceOf(NoopCachePort);

    env.CACHE_KV = kv;
    expect(getCachePort(env)).toBeInstanceOf(KvCachePort);

    delete env.CACHE_KV;
    expect(getCachePort(env)).toBeInstanceOf(NoopCachePort);
  });

  it("键存在但值为 undefined → 仍为 Noop", () => {
    expect(getCachePort({ CACHE_KV: undefined })).toBeInstanceOf(NoopCachePort);
  });

  it("KvCachePort 读写与 TTL<=0 不写", async () => {
    const { kv, store } = makeFakeKv();
    const port = new KvCachePort(kv);

    await port.put("hot", "value", 30);
    expect(await port.get("hot")).toBe("value");
    expect(store.size).toBe(1);

    await port.put("cold", "value", 0);
    expect(store.has("cold")).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* S6 媒体缝                                                                    */
/* -------------------------------------------------------------------------- */

describe("S6 图片/媒体缝（docs/04 §4.3 S6）", () => {
  it("缺绑定 → NoopMediaPort，presignPut 返回 null", async () => {
    const port = getMediaPort({});
    expect(port).toBeInstanceOf(NoopMediaPort);
    await expect(port.presignPut("a.png", "image/png")).resolves.toBeNull();
  });

  it("加绑定 → R2MediaPort；删绑定 → 回到 Noop", () => {
    const env: { MEDIA?: R2Bucket } = {};
    expect(getMediaPort(env)).toBeInstanceOf(NoopMediaPort);

    env.MEDIA = fakeBucket;
    expect(getMediaPort(env)).toBeInstanceOf(R2MediaPort);

    delete env.MEDIA;
    expect(getMediaPort(env)).toBeInstanceOf(NoopMediaPort);
  });

  it("键存在但值为 undefined → 仍为 Noop", () => {
    expect(getMediaPort({ MEDIA: undefined })).toBeInstanceOf(NoopMediaPort);
  });

  it("R2MediaPort 未注入签发器时 presignPut 返回 null（不伪造 URL）", async () => {
    const port = new R2MediaPort(fakeBucket);
    await expect(port.presignPut("a.png", "image/png")).resolves.toBeNull();
  });

  it("R2MediaPort 注入签发器时返回凭据，过期时刻 = now + TTL", async () => {
    const port = new R2MediaPort(
      fakeBucket,
      async (input) => ({
        url: `https://upload.dshop.example.com/${input.key}`,
        headers: { "content-type": input.contentType },
      }),
      () => 1_700_000_000_000,
    );
    const result = await port.presignPut("/a.png", "image/png");
    expect(result?.url).toBe("https://upload.dshop.example.com/a.png");
    expect(result?.headers["content-type"]).toBe("image/png");
  });

  it("publicUrl 预留变体参数位：缺省不带参数，指定时追加 ?v=", () => {
    const port = new R2MediaPort(fakeBucket);
    expect(port.publicUrl("a.png")).toBe(`${MEDIA_PUBLIC_HOST}/a.png`);
    expect(port.publicUrl("a.png", "thumb")).toBe(`${MEDIA_PUBLIC_HOST}/a.png?v=thumb`);
    expect(port.publicUrl("a.png", "")).toBe(`${MEDIA_PUBLIC_HOST}/a.png`);
  });
});
