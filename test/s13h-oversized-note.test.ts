/**
 *  遗留（扩展）2026-10-29：超大笔记不再卡死——分章阅读 + 整篇编辑明确停用。
 *
 * 真机读数（隔离实例，CDP 输入管线）：
 *  - 100KB（约 1.9k 段）阅读渲染 ≈ 978ms；
 *  - 300KB（约 5.7k 段）≈ 5956ms（超线性）；
 *  - 1MB（约 1.9 万段）直接把渲染进程卡住：CDP /json 请求 20s 超时、应用无响应，只能按 PID 回收。
 *
 * 判据：
 *  ① 切分**无损**：chunks.map(t=>t.text).join('') === 原文（一个字节都不能丢）；
 *  ② 每章 ≤ 上限；超长单段（无空行）也要切；
 *  ③ 分章优先落在标题前，章标题可取；
 *  ④ 页面：>200KB 才分章；分章条有上一章/下一章；阅读编辑器只喂当前章；
 *  ⑤ 编辑：超大笔记明确停用整篇编辑并给回到阅读的出口（不摆假编辑器）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  EDIT_CHUNK_MAX_CHARS,
  READ_CHUNK_MAX_CHARS,
  READ_FULL_MAX_CHARS,
  chunkRanges,
  spliceChunk,
  splitMarkdownForRead,
} from '../src/renderer/components/knowledgeChunks.js';

function doc(chars: number, paraChars = 50): string {
  let out = '# 大文档\n\n';
  let i = 0;
  while (out.length < chars) {
    const body = `## 小节 ${++i}\n${'这是一段正文，包含中文与 English mixed，用来把段落填充到目标长度。'.repeat(1)}`;
    out += body + '\n\n';
    if (body.length < paraChars) out += 'x'.repeat(paraChars - body.length) + '\n\n';
  }
  return out;
}

test('分章① 无损：拼接结果与原文逐字节一致（1MB）', () => {
  const content = doc(1_000_000);
  const chunks = splitMarkdownForRead(content);
  assert.ok(chunks.length > 1, '1MB 必须分章');
  assert.equal(chunks.map((c) => c.text).join(''), content, '拼接必须还原原文');
  assert.equal(
    chunks.reduce((n, c) => n + c.chars, 0),
    content.length,
  );
});

test('分章② 每章不超上限；无空行的超长单段也要切', () => {
  const longParagraph = 'a'.repeat(READ_CHUNK_MAX_CHARS * 2 + 123);
  const chunks = splitMarkdownForRead(`# 头\n\n${longParagraph}\n`, READ_CHUNK_MAX_CHARS);
  assert.ok(chunks.length >= 3, `超长单段应被切开，实际 ${chunks.length}`);
  for (const c of chunks) assert.ok(c.chars <= READ_CHUNK_MAX_CHARS, `章超限：${c.chars}`);
  assert.equal(chunks.map((c) => c.text).join(''), `# 头\n\n${longParagraph}\n`);
});

test('分章③ 短文不分章；章标题取首个标题行', () => {
  const small = '# 标题\n\n正文\n';
  const one = splitMarkdownForRead(small);
  assert.equal(one.length, 1);
  assert.equal(one[0]!.text, small);
  assert.equal(one[0]!.title, '标题');

  const big = doc(400_000);
  const chunks = splitMarkdownForRead(big);
  assert.ok(chunks.length >= 3);
  for (const c of chunks) assert.ok(c.title.length > 0, '每章都要有可读标题');
});

test('页面④ 分章门槛与分章阅读条接线（阅读只喂当前章）', () => {
  const page = readFileSync('src/renderer/components/KnowledgePage.tsx', 'utf8');
  assert.match(page, /READ_FULL_MAX_CHARS/, '门槛来自常量，不散落魔法数');
  assert.match(page, /splitMarkdownForRead\(editContent\)/);
  assert.match(page, /'data-testid':\s*'knowledge-chunks'/);
  assert.match(page, /'data-testid':\s*'knowledge-chunk-prev'/);
  assert.match(page, /'data-testid':\s*'knowledge-chunk-next'/);
  assert.match(page, /value: readChunks != null \? readChunks\[chunkIndex\]!\.text : editContent/, '阅读编辑器只拿当前章');
  // 2026-10-29 性能：阅读分章复用同一只读实例（replaceAll 换章），不再每章重建。
  assert.match(page, /key: 'knowledge-read'/, '阅读分章复用同一实例');
  // 关键性能守卫：切分必须 memo，否则每次 render 生成新字符串 → value 同步 effect 反复 replaceAll。
  assert.match(page, /const readChunks = useMemo\(/, '阅读切分必须 memo');
  assert.match(page, /const editChunks = useMemo\(/, '编辑切分必须 memo');
});

test('编辑⑤ 大笔记分章编辑：段条、切章重建、保存只写回本章', () => {
  const page = readFileSync('src/renderer/components/KnowledgePage.tsx', 'utf8');
  assert.match(page, /EDIT_CHUNK_MAX_CHARS/, '编辑门槛来自常量');
  assert.match(page, /'data-testid':\s*'knowledge-edit-chunks'/);
  assert.match(page, /'data-testid':\s*'knowledge-edit-chunk-prev'/);
  assert.match(page, /'data-testid':\s*'knowledge-edit-chunk-next'/);
  assert.match(page, /key: editChunks != null \? `knowledge-edit-\$\{editChunkIndex\}`/, '切章必须重建编辑器');
  assert.match(page, /spliceChunk\(editContent, editChunks, editChunkIndex, edited\)/, '保存要把本章拼回全文');
  assert.match(page, /保存只写回本章/);
  assert.doesNotMatch(page, /knowledge-too-large/, '不再有“整篇编辑停用”分支（改为分章编辑）');
});

test('分章编辑：区间连续、拼回只改本章（其余字节不动）', () => {
  const content = doc(200_000);
  const chunks = splitMarkdownForRead(content, EDIT_CHUNK_MAX_CHARS);
  assert.ok(chunks.length >= 3, `200KB 按 ${EDIT_CHUNK_MAX_CHARS} 应分多章，实际 ${chunks.length}`);
  const ranges = chunkRanges(content, chunks);
  assert.equal(ranges[0]!.start, 0);
  assert.equal(ranges.at(-1)!.end, content.length);
  for (let i = 1; i < ranges.length; i += 1) assert.equal(ranges[i]!.start, ranges[i - 1]!.end, '区间必须连续');
  for (const r of ranges) assert.ok(r.end - r.start <= EDIT_CHUNK_MAX_CHARS);

  const edited = '# 改过的章\n\n新正文\n';
  const patched = spliceChunk(content, chunks, 1, edited);
  assert.equal(patched, content.slice(0, ranges[1]!.start) + edited + content.slice(ranges[1]!.end));
  assert.equal(spliceChunk(content, chunks, 1, chunks[1]!.text), content, '原样拼回必须等于原文');
});

test('常量口径：阅读整篇门槛 ≥ 单章上限；编辑章上限更小（打字跟手）', () => {
  assert.ok(READ_CHUNK_MAX_CHARS >= 40_000 && READ_CHUNK_MAX_CHARS <= 120_000);
  assert.ok(READ_FULL_MAX_CHARS >= READ_CHUNK_MAX_CHARS);
  assert.ok(EDIT_CHUNK_MAX_CHARS >= 10_000 && EDIT_CHUNK_MAX_CHARS <= 60_000);
  assert.ok(EDIT_CHUNK_MAX_CHARS <= READ_CHUNK_MAX_CHARS, '编辑章必须不宽于阅读章');
});

test('编辑器失败态：编辑/阅读都不退回源码（显式报错＋重试）', () => {
  const editor = readFileSync('src/renderer/components/MilkdownEditor.tsx', 'utf8');
  assert.doesNotMatch(editor, /createElement\('textarea'/, '不得用 textarea 展示源码（任何状态）');
  assert.match(editor, /'data-testid': readOnly \? 'milkdown-readonly-failed' : 'milkdown-edit-failed'/);
  assert.match(editor, /'data-testid': readOnly \? 'milkdown-readonly-retry' : 'milkdown-edit-retry'/);
  assert.match(editor, /setAttempt\(\(n\) => n \+ 1\)/, '重试要能重挂编辑器');
  assert.match(editor, /\}, \[attempt\]\)/, '初始化 effect 必须依赖重试计数');
});
