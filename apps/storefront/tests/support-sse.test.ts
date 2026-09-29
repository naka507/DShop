/**
 * SSE 帧解析单测。
 *
 * 覆盖两个**真实会踩**的边界（见 `src/support/sse.ts` 的文件头注释）：
 * 跨 chunk 半帧、心跳注释帧。这两点错了不会报错，只会静默丢消息或多出空消息。
 */

import { describe, expect, it } from "vitest";

import { SseFrameParser, parseFrame } from "../src/support/sse.ts";

describe("parseFrame", () => {
  it("解析 event / data / id 三行", () => {
    const frame = parseFrame('id: 42\nevent: chunk\ndata: {"delta":"你"}');
    expect(frame).toEqual({ event: "chunk", data: '{"delta":"你"}', id: "42" });
  });

  it("缺省事件名为 message（SSE 规范默认）", () => {
    const frame = parseFrame('data: {"a":1}');
    expect(frame?.event).toBe("message");
    expect(frame?.id).toBeNull();
  });

  it("吃掉冒号后的一个空格", () => {
    const frame = parseFrame("data:  two spaces");
    expect(frame?.data).toBe(" two spaces");
  });

  it("多行 data 按规范以 \\n 连接", () => {
    const frame = parseFrame("event: chunk\ndata: line1\ndata: line2");
    expect(frame?.data).toBe("line1\nline2");
  });

  it("注释帧（心跳 `: ping`）返回 null", () => {
    expect(parseFrame(": ping")).toBeNull();
  });

  it("注释行不影响同帧其余字段", () => {
    const frame = parseFrame('event: chunk\n: keep-alive\ndata: {"delta":"x"}');
    expect(frame).toEqual({ event: "chunk", data: '{"delta":"x"}', id: null });
  });

  it("无 data 的帧返回 null", () => {
    expect(parseFrame("event: chunk\nid: 7")).toBeNull();
  });

  it("兼容 \\r\\n 行尾", () => {
    const frame = parseFrame('event: chunk\r\ndata: {"delta":"y"}\r\nid: 9');
    expect(frame).toEqual({ event: "chunk", data: '{"delta":"y"}', id: "9" });
  });

  it("空串返回 null", () => {
    expect(parseFrame("")).toBeNull();
  });
});

describe("SseFrameParser", () => {
  it("跨 chunk 的半帧不会提前产出", () => {
    const parser = new SseFrameParser();
    // 一帧被网络切成三次：event 行、data 行、结尾空行。
    expect(parser.push("event: chu")).toEqual([]);
    expect(parser.push('nk\ndata: {"delta":"你"}\n')).toEqual([]);
    const frames = parser.push("\n");
    expect(frames).toHaveLength(1);
    expect(frames[0]?.event).toBe("chunk");
    expect(frames[0]?.data).toBe('{"delta":"你"}');
  });

  it("一个 chunk 含多帧时全部产出", () => {
    const parser = new SseFrameParser();
    const frames = parser.push(
      'event: chunk\ndata: {"delta":"a"}\n\nevent: chunk\ndata: {"delta":"b"}\n\n',
    );
    expect(frames.map((frame) => frame.data)).toEqual(['{"delta":"a"}', '{"delta":"b"}']);
  });

  it("帧间心跳注释帧被忽略", () => {
    const parser = new SseFrameParser();
    const frames = parser.push(
      'event: chunk\ndata: {"delta":"a"}\n\n: ping\n\nevent: finish\ndata: {"suggestedActions":[]}\n\n',
    );
    expect(frames.map((frame) => frame.event)).toEqual(["chunk", "finish"]);
  });

  it("残留半帧留给下一次 push 拼接", () => {
    const parser = new SseFrameParser();
    expect(parser.push('data: {"delta":"a"}\n\ndata: {"del')).toHaveLength(1);
    const frames = parser.push('ta":"b"}\n\n');
    expect(frames).toHaveLength(1);
    expect(frames[0]?.data).toBe('{"delta":"b"}');
  });

  it("flush 产出结尾未以空行收尾的残帧", () => {
    const parser = new SseFrameParser();
    expect(parser.push('event: finish\ndata: {"suggestedActions":[]}')).toEqual([]);
    const frames = parser.flush();
    expect(frames).toHaveLength(1);
    expect(frames[0]?.event).toBe("finish");
  });

  it("flush 后缓冲区清空，再 flush 返回空数组", () => {
    const parser = new SseFrameParser();
    parser.push('data: {"a":1}');
    expect(parser.flush()).toHaveLength(1);
    expect(parser.flush()).toEqual([]);
  });

  it("只有心跳时 flush 返回空数组", () => {
    const parser = new SseFrameParser();
    parser.push(": ping\n");
    expect(parser.flush()).toEqual([]);
  });
});
