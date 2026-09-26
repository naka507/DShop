/**
 * S6 图片 / 媒体升级缝（`docs/04` §4.3 S6、`docs/12` §12.9.3–§12.9.4、§12.15 P1-3）。
 *
 * ## 缝的形态
 *
 * | 绑定状态 | 实现 | 语义 |
 * | --- | --- | --- |
 * | `env.MEDIA` **缺省** | {@link NoopMediaPort} | **不提供上传入口**（`presignPut` 恒为 `null`），`publicUrl` 返回空串。零配置、免费层可用。 |
 * | `env.MEDIA` **存在** | {@link R2MediaPort} | R2 对象存储（`dshop-assets` 桶）承载媒体，公开只读走 `R2_PUBLIC` 自定义域。 |
 *
 * **开关方式**：在 `apps/api/wrangler.jsonc` 增删 `r2_buckets` 绑定，代码零改动；
 * **删绑定即回滚**（`docs/12` §12.9.4 第 1 条）。
 *
 * ## URL 规范预留变体参数位（对齐 eshop S6）
 *
 * `docs/12` §12.9.3 S6「URL 规范已预留变体参数位」——即**今天就把变体位放进 URL 形态**，
 * 将来升级到 Image Resizing / Cloudflare Images 时**调用方一行不改**。
 * 本实现把变体放在**查询参数** `?v=<variant>`：路径保持不变（CDN 缓存键友好），
 * 变体参数缺省时**不出现**（避免产生 `?v=` 这种无意义键，把缓存打散）。
 *
 * ## 诚实边界：R2 绑定不能自己签发直传 URL
 *
 * Cloudflare 的 **R2 绑定（`R2Bucket`）没有「预签名 URL」能力**——S3 风格的
 * presigned URL 需要 R2 的 S3 凭证（access key / secret），那是**独立的 secret**，
 * 不在本缝的 `env.MEDIA` 里。因此本实现把「签发」抽象成可选注入的
 * {@link MediaUploadSigner}：注入时 `presignPut` 返回真实直传地址与头；
 * 未注入时**按接口契约返回 `null`**（= 本环境未配置上传端点），
 * **绝不伪造一个不能用的 URL**。
 */

/* -------------------------------------------------------------------------- */
/* 接口                                                                        */
/* -------------------------------------------------------------------------- */

/** 直传凭据：地址 + 调用方必须原样带上的请求头。 */
export interface MediaPresignResult {
  readonly url: string;
  readonly headers: Record<string, string>;
}

/**
 * 媒体端口——升级缝的**唯一抽象点**。
 *
 * 业务代码只依赖本接口，禁止直接 `import` R2 / Images / Resizing SDK。
 */
export interface MediaPort {
  /**
   * 申请一次直传（PUT）凭据；**返回 `null` 表示本环境不提供上传入口**。
   *
   * `null` 是契约的一部分，不是错误：默认实现恒为 `null`，
   * 调用方必须把 `null` 当作「走降级路径（例如提示不可上传 / 走后台导入）」。
   */
  presignPut(key: string, contentType: string): Promise<MediaPresignResult | null>;
  /** 公开只读 URL；`variant` 为预留的变体位（如 `thumb` / `w600`）。 */
  publicUrl(key: string, variant?: string): string;
}

/* -------------------------------------------------------------------------- */
/* 公开域（唯一来源）                                                           */
/* -------------------------------------------------------------------------- */

/**
 * 媒体公开只读域。
 *
 * 取值依据 `docs/04` §4.2 绑定清单：`R2_PUBLIC` 是 `dshop-assets` 桶的公开只读入口，
 * 自定义域为 `img.dshop.example.com`。此处硬编码该域，与文档一致；
 * 换域时只需改这一处。
 */
export const MEDIA_PUBLIC_HOST = "https://img.dshop.example.com";

/** 变体参数名（预留位，见文件头说明）。 */
export const MEDIA_VARIANT_PARAM = "v";

/** 去掉 key 的前导 `/`，避免拼出 `//` 双斜杠（CDN 会当成不同对象）。 */
function normalizeKey(key: string): string {
  return key.replace(/^\/+/u, "");
}

/* -------------------------------------------------------------------------- */
/* 默认实现：不提供上传                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 默认实现：**不提供上传入口**（`docs/04` §4.3 S6 的「零配置」形态）。
 *
 * 一期图片加工形态是「上传时生成固定尺寸」（`docs/12` §12.9.3 S6），
 * 未绑定媒体存储时业务侧没有直传能力——这**不是缺失**，而是当前形态：
 * 商品图由后台导入 / 静态资源承载。
 */
export class NoopMediaPort implements MediaPort {
  /** 恒为 `null`：本环境无媒体存储绑定。 */
  public async presignPut(_key: string, _contentType: string): Promise<MediaPresignResult | null> {
    return null;
  }

  /**
   * 无媒体存储 → 无可公开 URL，返回空串。
   *
   * 返回空串而非抛错：调用方（模板 / 序列化）只需判断真假即可降级占位图，
   * 抛错会把「没有图」升级成「接口 500」。
   */
  public publicUrl(_key: string, _variant?: string): string {
    return "";
  }
}

/* -------------------------------------------------------------------------- */
/* 升级实现：R2                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * 直传签发器（可选注入，见文件头「诚实边界」）。
 *
 * 输入是待上传对象的标识与过期时刻，输出是**调用方直接 PUT** 的地址与头。
 * 真实实现通常用 R2 S3 凭证生成 presigned URL，或走 Worker 中转签名。
 */
export type MediaUploadSigner = (input: {
  readonly key: string;
  readonly contentType: string;
  /** 凭据过期时刻（Unix 秒）。 */
  readonly expiresAtSeconds: number;
}) => Promise<MediaPresignResult>;

/** 直传凭据默认有效期（秒）。 */
export const MEDIA_PRESIGN_TTL_SECONDS = 900;

/**
 * 升级实现：`env.MEDIA`（R2Bucket）。
 *
 * @param bucket  `env.MEDIA` 绑定。
 * @param signer  直传签发器；**未注入时 `presignPut` 返回 `null`**（见文件头）。
 * @param nowMs   当前时刻注入点（默认 `Date.now`），仅供测试。
 */
export class R2MediaPort implements MediaPort {
  public constructor(
    private readonly bucket: R2Bucket,
    private readonly signer?: MediaUploadSigner,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  /**
   * 申请直传凭据。
   *
   * 未注入签发器 → 返回 `null`（本环境未配置上传端点）。
   * 注意：这里**不**调用 `bucket`——绑定本身不提供签名能力，
   * 保留它是因为它证明「媒体存储已就绪」，且后续中转上传实现需要用它落对象。
   */
  public async presignPut(key: string, contentType: string): Promise<MediaPresignResult | null> {
    if (this.signer === undefined) return null;

    const expiresAtSeconds = Math.floor(this.nowMs() / 1000) + MEDIA_PRESIGN_TTL_SECONDS;
    return this.signer({ key: normalizeKey(key), contentType, expiresAtSeconds });
  }

  /**
   * 公开只读 URL（走 `R2_PUBLIC` 自定义域，`docs/04` §4.2）。
   *
   * 变体参数位：`variant` 非空时才追加 `?v=<variant>`（见文件头）。
   */
  public publicUrl(key: string, variant?: string): string {
    const base = `${MEDIA_PUBLIC_HOST}/${normalizeKey(key)}`;
    if (variant === undefined || variant.length === 0) return base;
    return `${base}?${MEDIA_VARIANT_PARAM}=${encodeURIComponent(variant)}`;
  }
}

/* -------------------------------------------------------------------------- */
/* 绑定驱动的工厂                                                               */
/* -------------------------------------------------------------------------- */

/**
 * 按**绑定存在性**选择实现（`docs/12` §12.9.4 第 1 条）。
 *
 * 检测写法固定为 `'MEDIA' in env && env.MEDIA`：`in` 兼容「键存在但值为 `undefined`」，
 * 真值判断兼容「键本身不存在」。两种缺省形态都回落到不提供上传的默认实现。
 */
export function getMediaPort(env: { MEDIA?: R2Bucket }): MediaPort {
  if ("MEDIA" in env && env.MEDIA) return new R2MediaPort(env.MEDIA);
  return new NoopMediaPort();
}
