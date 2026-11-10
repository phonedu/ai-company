/**
 * K1 知识库 · 格式兼容测试（2026-10-27 要求「全部格式都能显示正确」）。
 *
 * 判据：
 * ① 各种 Markdown 格式的笔记能创建→读回→内容不丢失；
 * ② 特殊字符（中文/emoji/代码块/表格/长行）在文件名和内容中都安全；
 * ③ 搜索能命中各种格式的内容；
 * ④ 升级为文档后格式不变。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeNote, readNote, searchNotes, promoteNote, listNotes } from '../src/main/agent/notes.js';

const root = mkdtempSync(join(tmpdir(), 'aico-k1-fmt-'));
const projDir = join(root, 'proj');
const globalDir = join(root, 'global');
mkdirSync(join(projDir, '.aico', 'notes'), { recursive: true });
mkdirSync(join(projDir, '.aico', 'docs'), { recursive: true });
mkdirSync(join(globalDir, 'notes'), { recursive: true });

const FORMATS: Array<{ name: string; content: string; searchHit: string }> = [
  {
    name: 'headings',
    content: '# 一级标题\n\n## 二级标题\n\n### 三级标题\n\n正文段落。',
    searchHit: '一级标题',
  },
  {
    name: 'list-format',
    content: '# 列表\n\n- 无序列表项 1\n- 无序列表项 2\n\n1. 有序列表项 1\n2. 有序列表项 2\n\n- [ ] 待办事项\n- [x] 已完成事项',
    searchHit: '无序列表项',
  },
  {
    name: 'code-block',
    content: '# 代码块\n\n```typescript\nconst x: number = 42;\nconsole.log(x);\n```\n\n```python\nprint("hello")\n```',
    searchHit: 'const x',
  },
  {
    name: 'table',
    content: '# 表格\n\n| 列A | 列B | 列C |\n|---|---|---|\n| 值1 | 值2 | 值3 |\n| 甲 | 乙 | 丙 |',
    searchHit: '值1',
  },
  {
    name: 'blockquote',
    content: '# 引用\n\n> 这是引用的第一行\n> 这是引用的第二行\n\n正文。',
    searchHit: '引用的第一行',
  },
  {
    name: 'link-image',
    content: '# 链接与图片\n\n[百度](https://baidu.com)\n\n![截图](screenshot.png)\n\n行内代码 `npm install`。',
    searchHit: 'baidu',
  },
  {
    name: 'chinese-mixed',
    content: '# 中英混合 Mixed\n\n部署 deploy 到生产 production 环境。\n\n数据库 database 连接 connection。',
    searchHit: 'deploy',
  },
  {
    name: 'long-line',
    content: '# 长行\n\n' + '这是一段很长的中文文本，'.repeat(50) + '用于测试长行截断。',
    searchHit: '长行截断',
  },
  {
    name: 'special-chars',
    content: '# 特殊字符\n\n<>$&{}[]()!@#%^*+-=/\\|~`"\n\nHTML 实体：&amp; &lt; &gt;\n\nEmoji：🚀 ✅ ❌ 📝',
    searchHit: '特殊字符',
  },
  {
    name: 'empty-content',
    content: '',
    searchHit: '',
  },
  {
    name: '中文文件名',
    content: '# 中文文件名测试\n\n这条笔记的文件名是中文的。',
    searchHit: '中文文件名',
  },
  {
    name: 'nested-format',
    content: `# 嵌套格式\n\n## 代码中的列表\n\n\`\`\`yaml\nitems:\n  - name: item1\n  - name: item2\n\`\`\`\n\n## 引用中的代码\n\n> \`\`\`js\n> console.log("in quote");\n> \`\`\`\n\n**粗体** *斜体* ~~删除线~~`,
    searchHit: 'item1',
  },
];

test('K1-格式 ① 各种 Markdown 格式创建→读回→内容不丢失', () => {
  try {
    for (const fmt of FORMATS) {
      const w = writeNote({ projectDir: projDir, globalDir, name: fmt.name, content: fmt.content });
      assert.ok(w.ok, `「${fmt.name}」写入应成功`);
      const r = readNote({ projectDir: projDir, globalDir, name: fmt.name });
      assert.ok(r.ok, `「${fmt.name}」读回应成功`);
      if (fmt.content.length > 0) {
        assert.equal(r.content, fmt.content, `「${fmt.name}」内容应完全一致`);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('K1-格式 ② 特殊字符文件名安全', () => {
  try {
    // 合法中文名
    assert.ok(writeNote({ projectDir: projDir, globalDir, name: '部署手册', content: 'test' }).ok);
    assert.ok(writeNote({ projectDir: projDir, globalDir, name: 'api_v2.config', content: 'test' }).ok);
    assert.ok(writeNote({ projectDir: projDir, globalDir, name: 'my-note', content: 'test' }).ok);
    // 非法名（路径穿越/特殊字符）
    assert.ok(!writeNote({ projectDir: projDir, globalDir, name: '../evil', content: 'x' }).ok);
    assert.ok(!writeNote({ projectDir: projDir, globalDir, name: 'foo/bar', content: 'x' }).ok);
    assert.ok(!writeNote({ projectDir: projDir, globalDir, name: 'foo\\bar', content: 'x' }).ok);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('K1-格式 ③ 搜索能命中各种格式内容', () => {
  try {
    for (const fmt of FORMATS) {
      if (fmt.searchHit.length === 0) continue;
      writeNote({ projectDir: projDir, globalDir, name: fmt.name, content: fmt.content });
    }
    const hits = searchNotes({ query: '标题', projects: [{ id: 1, name: '项目', rootDir: projDir }], globalDir });
    assert.ok(hits.length > 0, `搜「标题」应命中（实际 ${hits.length}）`);
    const codeHits = searchNotes({ query: 'const', projects: [{ id: 1, name: '项目', rootDir: projDir }], globalDir });
    assert.ok(codeHits.some(h => h.name === 'code-block'), `搜「const」应命中代码块`);
    const zhHits = searchNotes({ query: '部署', projects: [{ id: 1, name: '项目', rootDir: projDir }], globalDir });
    assert.ok(zhHits.length > 0, `搜「部署」应命中`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('K1-格式 ④ 升级为文档后内容不变', () => {
  try {
    const content = '# 升级测试\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```js\nconsole.log("keep");\n```';
    writeNote({ projectDir: projDir, globalDir, name: 'promote-fmt-test', content });
    const p = promoteNote({ projectDir: projDir, name: 'promote-fmt-test' });
    assert.ok(p.ok, `升级应成功`);
    const promoted = readFileSync(join(projDir, '.aico', 'docs', 'promote-fmt-test.md'), 'utf8');
    assert.equal(promoted, content, '升级后内容应完全一致');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('K1-格式 ⑤ 空内容笔记创建→列表显示→读回空字符串', () => {
  try {
    writeNote({ projectDir: projDir, globalDir, name: 'empty-note', content: '' });
    const items = listNotes({ projects: [{ id: 1, name: '项目', rootDir: projDir }], globalDir });
    const empty = items.find(i => i.name === 'empty-note');
    assert.ok(empty != null, '空笔记应在列表中');
    assert.equal(empty.lines, 1, '空文件 1 行');
    const r = readNote({ projectDir: projDir, globalDir, name: 'empty-note' });
    assert.ok(r.ok);
    assert.equal(r.content, '', '读回应为空字符串');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
