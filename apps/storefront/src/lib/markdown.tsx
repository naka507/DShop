/**
 * 极简 Markdown 渲染器（**只支持政策正文实际用到的子集**）。
 *
 * ## 为什么不引第三方库
 *
 * 政策正文（`docs/07` §7.7 的 `content`）是 markdown，但内容由平台运营撰写、
 * 结构简单（标题 / 段落 / 无序列表 / 有序列表 / 加粗）。
 * 引入 `marked` + `DOMPurify` 会增加两个依赖与一处 XSS 风险面，
 * 而本任务禁止 `npm install`、也要求最小依赖。
 *
 * ## 安全口径
 *
 * 本渲染器**输出 React 元素而非 HTML 字符串**：不调用 `dangerouslySetInnerHTML`，
 * 因此正文里出现 `<script>` 之类的内容只会被当作**纯文本**渲染，不构成 XSS
 * （`docs/01` §1.4 P3「脱敏在源头」的同一思路：不在渲染层做安全兜底，而是
 * 从结构上不给注入面）。
 */

import type { ReactNode } from "react";

/** 行内加粗解析：`**text**` → `<strong>text</strong>`。 */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter((part) => part !== "");
  return parts.map((part, index) => {
    const key = `${keyPrefix}-${String(index)}`;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    return <span key={key}>{part}</span>;
  });
}

/**
 * 渲染 markdown 子集。
 *
 * 支持：`#`/`##`/`###` 标题、`-`/`*` 无序列表、`1.` 有序列表、空行分段、行内加粗。
 * 其余语法（表格、代码块、链接、图片）**按纯文本原样输出**——宁可少渲染，
 * 也不做半吊子解析。
 */
export function renderMarkdown(source: string): ReactNode {
  const lines = source.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: { readonly ordered: boolean; readonly items: string[] } | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    const text = paragraph.join(" ");
    blocks.push(
      <p key={`p-${String(blocks.length)}`}>{renderInline(text, `p${String(blocks.length)}`)}</p>,
    );
    paragraph = [];
  };

  const flushList = (): void => {
    if (list === null) return;
    const items = list.items.map((item, index) => (
      <li key={`li-${String(index)}`}>
        {renderInline(item, `li${String(blocks.length)}-${String(index)}`)}
      </li>
    ));
    blocks.push(
      list.ordered ? (
        <ol key={`ol-${String(blocks.length)}`} className="ml-5 list-decimal space-y-1">
          {items}
        </ol>
      ) : (
        <ul key={`ul-${String(blocks.length)}`} className="ml-5 list-disc space-y-1">
          {items}
        </ul>
      ),
    );
    list = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (line.trim() === "") {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading !== null) {
      flushParagraph();
      flushList();
      const level = heading[1]?.length ?? 1;
      const text = heading[2] ?? "";
      const key = `h-${String(blocks.length)}`;
      if (level === 1)
        blocks.push(
          <h3 key={key} className="mt-2 text-base font-semibold">
            {text}
          </h3>,
        );
      else if (level === 2)
        blocks.push(
          <h4 key={key} className="mt-2 text-sm font-semibold">
            {text}
          </h4>,
        );
      else
        blocks.push(
          <h5 key={key} className="mt-2 text-sm font-medium">
            {text}
          </h5>,
        );
      continue;
    }

    const unordered = /^[-*]\s+(.*)$/.exec(line);
    if (unordered !== null) {
      flushParagraph();
      if (list === null || list.ordered) {
        flushList();
        list = { ordered: false, items: [] };
      }
      list.items.push(unordered[1] ?? "");
      continue;
    }

    const ordered = /^\d+\.\s+(.*)$/.exec(line);
    if (ordered !== null) {
      flushParagraph();
      if (list === null || !list.ordered) {
        flushList();
        list = { ordered: true, items: [] };
      }
      list.items.push(ordered[1] ?? "");
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();

  return <>{blocks}</>;
}
