/**
 *  遗留（的扩展）／2026-10-29：超大笔记分章阅读。
 *
 * 为什么：Crepe/ProseMirror 的挂载成本随文档**段落数**超线性增长——真机实测
 * 100KB≈1.0s、300KB≈6.0s、1MB（约 1.9 万段）直接把渲染进程卡到 CDP 都不回话。
 * 阅读态又不允许显示 Markdown 源码（2026-10-28 裁 D），所以不能退回复制原文，
 * 只能把长文按章切开、一次只渲染一章。
 *
 * 口径：
 *  - splitMarkdownForRead(content).map(c=>c.text).join('') === content（**无损**，不改一个字节）；
 *  - 分章优先落在 `#`/`##` 标题前；单章超限时先按字符硬切（仍无损），不让任何一段超过 maxChars；
 *  - 标题取每章首个标题行，便于跳转时认得出在哪。
 */

/** 阅读单章上限（真机 60KB ≈ 0.9s；100KB 全量渲染 ≈ 1s，再大明显变慢）。 */
export const READ_CHUNK_MAX_CHARS = 60_000;

/** 超过这个长度阅读才分章；以下整篇渲染。 */
export const READ_FULL_MAX_CHARS = 120_000;

/**
 * 编辑单章上限（2026-10-29 实测：输入到下一帧 p90——10KB≈16ms、20KB≈12ms、
 * 40KB≈19ms、100KB≈35ms 且偶发 150ms；取 40KB 保住打字跟手）。
 * 超过这个长度整篇编辑改为**分章编辑**，保存时把本章无损拼回全文。
 */
export const EDIT_CHUNK_MAX_CHARS = 40_000;

export interface ReadChunk {
  /** 章标题（首个标题行；没有标题时给「第 N 章」）。 */
  title: string;
  /** 原文切片（逐字节无损）。 */
  text: string;
  chars: number;
}

function headingOf(text: string): string | null {
  const m = /^#{1,6}[ \t]+(.+)$/m.exec(text);
  return m ? m[1]!.trim() : null;
}

export function splitMarkdownForRead(content: string, maxChars: number = READ_CHUNK_MAX_CHARS): ReadChunk[] {
  const limit = Math.max(1_000, Math.floor(maxChars));
  if (content.length === 0) return [{ title: '（空）', text: '', chars: 0 }];
  if (content.length <= limit) {
    return [{ title: headingOf(content) ?? '第 1 章', text: content, chars: content.length }];
  }

  // ① 按一/二级标题切成「节」（保留行尾换行，拼接可还原原文）。
  const lines = content.split(/(?<=\n)/);
  const sections: string[] = [];
  let buf = '';
  for (const line of lines) {
    if (/^#{1,2}[ \t]/.test(line) && buf.length > 0) {
      sections.push(buf);
      buf = '';
    }
    buf += line;
  }
  if (buf.length > 0) sections.push(buf);

  // ② 单节超限 → 先按段落包，再对仍超限的段落做硬切（无损）。
  const pieces: string[] = [];
  for (const section of sections) {
    if (section.length <= limit) {
      pieces.push(section);
      continue;
    }
    const paras = section.split(/(?<=\n\n)/);
    let acc = '';
    for (const para of paras) {
      if (para.length > limit) {
        if (acc.length > 0) {
          pieces.push(acc);
          acc = '';
        }
        for (let at = 0; at < para.length; at += limit) pieces.push(para.slice(at, at + limit));
        continue;
      }
      if (acc.length + para.length > limit) {
        pieces.push(acc);
        acc = '';
      }
      acc += para;
    }
    if (acc.length > 0) pieces.push(acc);
  }

  // ③ 相邻节贪心打包成章。
  const texts: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (current.length + piece.length > limit) {
      if (current.length > 0) texts.push(current);
      current = '';
    }
    current += piece;
  }
  if (current.length > 0) texts.push(current);

  return texts.map((text, index) => ({
    title: headingOf(text) ?? `第 ${index + 1} 章`,
    text,
    chars: text.length,
  }));
}

/** 每章在原文中的区间（chunks 必须由同一 maxChars 切出；拼接无损时区间连续）。 */
export function chunkRanges(content: string, chunks: readonly ReadChunk[]): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let at = 0;
  for (const chunk of chunks) {
    out.push({ start: at, end: at + chunk.text.length });
    at += chunk.text.length;
  }
  // 防御：切分异常（理论上不会）→ 退化为整篇一章，绝不悄悄丢内容。
  if (at !== content.length) return [{ start: 0, end: content.length }];
  return out;
}

/** 把编辑后的某一章拼回全文（其余字节原样保留）。 */
export function spliceChunk(content: string, chunks: readonly ReadChunk[], index: number, edited: string): string {
  const ranges = chunkRanges(content, chunks);
  const range = ranges[Math.min(Math.max(index, 0), ranges.length - 1)]!;
  return `${content.slice(0, range.start)}${edited}${content.slice(range.end)}`;
}
