/**
 * S7 缓存**叠加**升级缝（`docs/04` §4.3 S7、`docs/12` §12.9.3–§12.9.4）。
 *
 * ## 缝的形态：S7 是「叠加」而非「切换」
 *
 * | 绑定状态 | 实现 | 语义 |
 * | --- | --- | --- |
 * | `env.CACHE_KV` **缺省** | {@link NoopCachePort} | **不叠加任何东西**——边缘 Cache API 已由 `apps/api/src/lib/cache.ts` 承担（TTL 唯一来源 `AGENT_ENDPOINTS[].cacheTtlSeconds`，`docs/07` §7.1）。 |
 * | `env.CACHE_KV` **存在** | {@link KvCachePort} | 在 Cache API 之上**叠加**热点 KV 缓存（跨 PoP 共享，命中不受单 PoP 冷启动影响）。 |
 *
 * ⚠️ 这里**没有**「默认实现」与「升级实现」的功能替换关系（`docs/04` §4.3 S7
 * 「按需叠加（新增 KV 绑定即生效，属「配置项」形态，不涉及实现替换）」）：
 * Cache API **始终在链路上**，KV 只是它前面的一层。所以默认实现是**空操作**，
 * 而不是「另一个缓存」。
 *
 * **开关方式**：在 `apps/api/wrangler.jsonc` 增删 `kv_namespaces` 绑定，代码零改动；
 * **删绑定即回滚**（回到纯 Cache API）。
 *
 * ## 计费纪律
 *
 * KV 免费层只有 1000 写/天（`docs/09` §9.x 免费层额度），因此**写入必须由调用方
 * 按热点显式触发**，本层不做任何自动回填/预写，避免悄悄烧掉配额。
 */

/* -------------------------------------------------------------------------- */
/* 接口                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 缓存叠加端口——升级缝的**唯一抽象点**。
 *
 * 只暴露字符串读写（热点 JSON / HTML 片段），不暴露 KV 的 metadata / list 等能力：
 * 接口越窄，升级目标越容易被替换（KV → Cache Reserve / 自建缓存层）。
 */
export interface CachePort {
  /** 取缓存；未命中返回 `null`（**不抛错**）。 */
  get(key: string): Promise<string | null>;
  /** 写缓存，`ttlSeconds` 为过期秒数（对齐 KV 的 `expirationTtl` 语义）。 */
  put(key: string, value: string, ttlSeconds: number): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* 默认实现：不叠加                                                             */
/* -------------------------------------------------------------------------- */

/**
 * 默认实现：**什么都不做**（S7 的「零配置」形态）。
 *
 * 不叠加 ≠ 没有缓存：边缘 Cache API（`apps/api/src/lib/cache.ts`）仍在链路上工作，
 * 只是不额外引入 KV 层。
 */
export class NoopCachePort implements CachePort {
  /** 永远未命中。 */
  public async get(_key: string): Promise<string | null> {
    return null;
  }

  /** 空操作。 */
  public async put(_key: string, _value: string, _ttlSeconds: number): Promise<void> {
    // 故意留空：默认形态不叠加任何缓存层（见文件头 S7 说明）。
  }
}

/* -------------------------------------------------------------------------- */
/* 升级实现：热点 KV                                                            */
/* -------------------------------------------------------------------------- */

/**
 * 升级实现：`env.CACHE_KV` 热点缓存（KVNamespace）。
 *
 * - `get` → `kv.get(key)`（文本），失败**向上抛**：缓存故障不应被静默当成未命中，
 *   否则会掩盖 KV 绑定配错（例如绑到了错误的 namespace id）。
 * - `put` → `kv.put(key, value, { expirationTtl: ttlSeconds })`。
 */
export class KvCachePort implements CachePort {
  /** @param kv `env.CACHE_KV` 绑定。 */
  public constructor(private readonly kv: KVNamespace) {}

  /** 读热点缓存。 */
  public async get(key: string): Promise<string | null> {
    return this.kv.get(key);
  }

  /**
   * 写热点缓存。
   *
   * `ttlSeconds <= 0` 时**不写**（避免写出 `expirationTtl: 0` 这种「立刻过期」的
   * 无意义写入，白烧免费层写入配额）。
   */
  public async put(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (!(ttlSeconds > 0)) return;
    await this.kv.put(key, value, { expirationTtl: ttlSeconds });
  }
}

/* -------------------------------------------------------------------------- */
/* 绑定驱动的工厂                                                               */
/* -------------------------------------------------------------------------- */

/**
 * 按**绑定存在性**选择实现（`docs/12` §12.9.4 第 1 条）。
 *
 * 检测写法固定为 `'CACHE_KV' in env && env.CACHE_KV`：`in` 兼容「键存在但值为 `undefined`」，
 * 真值判断兼容「键本身不存在」。两种缺省形态都返回不叠加的默认实现。
 */
export function getCachePort(env: { CACHE_KV?: KVNamespace }): CachePort {
  if ("CACHE_KV" in env && env.CACHE_KV) return new KvCachePort(env.CACHE_KV);
  return new NoopCachePort();
}
