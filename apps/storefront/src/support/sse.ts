/**
 * SSE 帧解析（纯函数，无 IO）。
 *
 * ## 为什么不用 `EventSource`
 *
 * PiEcho 网关的 `POST /api/v1/chat` 是 **POST + 请求体** 建流，而 `EventSource`
 * 只能发 GET、且**不能自定义 `Authorization` 头**。断线重连时需要带
 * `Last-Event-ID` 做增量补发，也必须能手工控制请求头，因此改用
 * `fetch` + `ReadableStream` 手工解析（与 PiEcho 侧 `web/src/useSSE.ts` 同一思路，
 * 那份是 Vue 实现，本文件是 DShop 侧的 React 原生重写）。
 *
 * ## 两个必须处理对的边界
 *
 * 1. **跨 chunk 半帧**：网络分片**不保证**按帧边界切。一帧 `event:`/`data:`/`id:`
 *    三行可能被切成两次 `read()`，所以解析器必须持有跨次调用的缓冲区，
 *    只在遇到**空行**（帧分隔符）时才产出一帧。
 * 2. **心跳注释帧**：网关会周期性发 `: ping`（以 `:` 开头的注释行）保活。
 *    它**不是**事件，必须被忽略——若误当成事件派发，前端会凭空多出一堆空消息。
 *
 * 帧格式（`server/src/sse/writer.ts`）：
 *
 * ```
 * id: 42
 * event: chunk
 * data: {"delta":"你"}
 * <空行>
 * ```
 */

/** 一帧解析结果。 */
export interface SseFrame {
  /** `event:` 行的值；缺省为 `"message"`（SSE 规范默认事件名）。 */
  readonly event: string;
  /** `data:` 行拼接结果（多行 `data:` 之间按规范以 `\n` 连接）。 */
  readonly data: string;
  /** `id:` 行的值；无则 `null`。用作 `Last-Event-ID` 游标。 */
  readonly id: string | null;
}

/** 帧分隔符：空行（兼容 `\r\n`）。 */
const FRAME_SEPARATOR = /\r?\n\r?\n/;

/**
 * 增量式 SSE 帧解析器。
 *
 * 用法：对每个网络分片调用 `push(text)`，拿到本次**完整**的帧数组；
 * 流结束时调用 `flush()` 处理末尾未以空行收尾的残帧。
 */
export class SseFrameParser {
  #buffer = "";

  /**
   * 追加一个分片并取出其中完整的帧。
   *
   * @param chunk 本次 `read()` 解出的文本（可能只含半帧）。
   */
  push(chunk: string): SseFrame[] {
    this.#buffer += chunk;
    const frames: SseFrame[] = [];
    for (;;) {
      const match = FRAME_SEPARATOR.exec(this.#buffer);
      if (match === null) break;
      const raw = this.#buffer.slice(0, match.index);
      this.#buffer = this.#buffer.slice(match.index + match[0].length);
      const frame = parseFrame(raw);
      if (frame !== null) frames.push(frame);
    }
    return frames;
  }

  /** 流结束：若缓冲区还残留一帧（无结尾空行），把它解析出来。 */
  flush(): SseFrame[] {
    const raw = this.#buffer;
    this.#buffer = "";
    if (raw.trim() === "") return [];
    const frame = parseFrame(raw);
    return frame === null ? [] : [frame];
  }
}

/**
 * 解析单个帧文本块。
 *
 * @returns 事件帧；注释帧（心跳）、空帧、无 `data` 的帧一律返回 `null`。
 */
export function parseFrame(raw: string): SseFrame | null {
  let event = "message";
  let id: string | null = null;
  const dataLines: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    // 注释行（心跳 `: ping`）：整行忽略，且不影响本帧其余字段。
    if (line.startsWith(":")) continue;
    if (line === "") continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    // 规范：冒号后若紧跟一个空格，该空格被吃掉。
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
    else if (field === "id") id = value;
    // `retry:` 等其余字段本网关不发，忽略。
  }

  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n"), id };
}
