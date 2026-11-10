/**
 * 文档管理最小版（§7 序 4）· 检查器**纯逻辑**守据。
 *
 * 口径：判据移植自 `test/docs-gate.test.ts`（去掉仓库特有豁免 → policy）；本测用**内存树**驱动
 * `checkDocs`，逐项"弄坏→必被报出"（有牙），并断 counts/truncated 如实。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { checkDocs, defaultDocsPolicy, normalizeDocRef, type DocsIo, type DocsPolicy } from '../src/main/docs/check.js';

/** 内存树：`{ 'a/b.md': '内容' }`。 */
function memIo(files: Record<string, string>): DocsIo {
  return {
    listFiles: () => Object.keys(files),
    read: (p) => (p in files ? files[p]! : null),
    exists: (p) => p in files || Object.keys(files).some((f) => f.startsWith(`${p}/`)),
  };
}

const HEADER = '> **头注**｜状态：在办｜规范的家：本件｜关闭时处置：归档\n\n正文\n';
const HEADER_LONG = '> **头注**｜状态：在办（说明）｜规范的家：本件（说明）｜关闭时处置：归档（说明）\n\n正文\n';

function policy(over: Partial<DocsPolicy> = {}): DocsPolicy {
  return { ...defaultDocsPolicy(), ...over };
}

test('docs-check: 干净树 → 0 issue；counts 如实（活/归档/悬空/超线）', () => {
  const io = memIo({
    'README.md': '# 文档入口\n\n【一次改动该动哪些文档】\n',
    'a/README.md': '# a 区\n\n- [doc1](./doc1.md)\n',
    'a/doc1.md': HEADER,
    'history/old.md': '老的（归档区不查）\n',
  });
  const r = checkDocs(policy(), io);
  assert.deepEqual(r.issues, []);
  assert.deepEqual(r.counts, { live: 3, archive: 1, dangling: 0, oversized: 0, issues: 0 });
  assert.equal(r.truncated, false);
});

test('docs-check·有牙: 缺入口 / 缺头注 / 索引缺 / 悬空引用 / 目录链接悬空 / 超线 / 坏命名 逐项必被报出', () => {
  const io = memIo({
    // 缺 README.md 入口
    'a/doc1.md': '没头注\n\n[悬空](./nope.md) [目录悬空](./nodir/)\n',
    'a/doc2.md': HEADER_LONG,
    'b/big.md': `${HEADER}${'x'.repeat(10)}\n`.repeat(3),
    'z/badname.md': HEADER,
  });
  const r = checkDocs(
    policy({ sizeLimit: 5, namingGrammar: /^doc\d+\.md$/, archiveZones: ['history/'] }),
    io,
  );
  const kinds = new Set(r.issues.map((i) => i.kind));
  assert.ok(kinds.has('entry'), '缺入口必报');
  assert.ok(kinds.has('header'), '缺头注必报（a/doc1.md）');
  assert.ok(kinds.has('index'), 'a 区有 2 份文档但缺 README.md ⇒ 缺区索引必报');
  assert.ok(kinds.has('ref'), '悬空文件引用必报');
  assert.ok(kinds.has('dirlink'), '悬空目录链接必报');
  assert.ok(kinds.has('size'), '超线必报（b/big.md）');
  assert.ok(kinds.has('naming'), '坏命名必报（z/badname.md）');
  assert.equal(r.counts.dangling, 2, '悬空计数＝文件引用＋目录链接');
  assert.ok(r.counts.oversized >= 1);

  // 对照（有牙的"牙"）：把每一项都修好 → 全清
  const fixed = memIo({
    'README.md': '# 入口\n',
    'a/README.md': '# a 区\n\n- doc1.md · doc2.md\n',
    'a/doc1.md': HEADER,
    'a/doc2.md': HEADER_LONG,
    'b/README.md': '# b\n\n- doc3.md\n',
    'b/doc3.md': HEADER,
    'z/README.md': '# z\n\n- `doc4.md`\n',
    'z/doc4.md': HEADER,
  });
  const r2 = checkDocs(policy({ sizeLimit: 600, namingGrammar: /^doc\d+\.md$/ }), fixed);
  assert.deepEqual(r2.issues, [], `修好后应全清，实际：${JSON.stringify(r2.issues)}`);
});

test('docs-check: 归档区免疫（不查引用/不计活文档）＋ 越界引用不计悬空', () => {
  const io = memIo({
    'README.md': '# 入口\n\n- [live](live.md) · [sub/doc.md](sub/doc.md)\n',
    'history/deep/old.md': '[随便一个不存在的引用](./gone.md)\n', // 归档区：不查
    'live.md': `${HEADER}\n[越出根](../../outside.md)\n[根相对写法](./README.md)\n`, // 越界 ⇒ null；相对本文件 ⇒ 存在
    'sub/doc.md': `${HEADER}\n[裸路径·相对本文件回退](../README.md)\n`,
  });
  const r = checkDocs(policy(), io);
  assert.deepEqual(r.issues, []);
  assert.equal(r.counts.live, 3, 'README + live.md + sub/doc.md');
  assert.equal(r.counts.archive, 1);
});

test('docs-check: issue 超上限 ⇒ 截断且如实标注（不静默）', () => {
  const files: Record<string, string> = { 'README.md': '# 入口\n\n- m0.md m1.md m2.md m3.md\n' };
  for (let i = 0; i < 4; i += 1) files[`m${i}.md`] = '没头注\n'; // 4 个 header issue
  const r = checkDocs(policy({ maxIssues: 2 }), memIo(files));
  assert.equal(r.issues.length, 2, '只回 2 条');
  assert.equal(r.truncated, true, '被截断必须如实标注');
  assert.equal(r.counts.issues, 4, '计数仍是全量');
});

test('docs-check: normalizeDocRef 口径（相对本文件解析；锚点/外链/越界 → null）', () => {
  assert.equal(normalizeDocRef('./a.md', 'x/y.md'), 'x/a.md');
  assert.equal(normalizeDocRef('../z.md', 'x/y.md'), 'z.md');
  assert.equal(normalizeDocRef('a/b.md', 'x/y.md'), 'x/a/b.md', '裸路径按 markdown 标准＝相对本文件（文档根相对在 checkDocs 里兜底）');
  assert.equal(normalizeDocRef('../../out.md', 'x/y.md'), null, '越出文档根 ⇒ null');
  assert.equal(normalizeDocRef('#anchor', 'x/y.md'), null);
  assert.equal(normalizeDocRef('https://example.com', 'x/y.md'), null);
});
