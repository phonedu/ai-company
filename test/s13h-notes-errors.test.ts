/**
 * 2026-10-29（未验证收口 / 错误态）：笔记 IPC 失败必须可见——不能静默当成功。
 *
 * 真机复现：把 big-perf.md 置只读后点「保存」，writeFileSync 抛 EPERM → IPC reject →
 * 旧实现没有 try/catch，界面零反馈（既没「已保存」也没「保存失败」），老板会以为写盘成功。
 *
 * 判据：保存/删除/创建/升级四个入口都有 try/catch，且失败文案含「保存失败/删除失败/创建失败/升级失败」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync('src/renderer/components/KnowledgePage.tsx', 'utf8');

test('笔记四个写入口都捕获 IPC 异常并给失败文案', () => {
  for (const label of ['保存失败', '删除失败', '创建失败', '升级失败']) {
    assert.ok(page.includes(label), `缺少失败文案：${label}`);
  }
  // catch 里可能有注释行（保存分支专门写了为什么必须可见），所以允许最多 200 字符间隔。
  const catches = page.match(/} catch \(error\) \{[\s\S]{0,200}?setMessage\(`(保存|删除|创建|升级)失败：/g) ?? [];
  assert.ok(catches.length >= 4, `四个入口都要 catch（实际 ${catches.length}）`);
});

test('保存失败不退出编辑态（不丢输入）', () => {
  const block = page.slice(page.indexOf('const handleSave'), page.indexOf('const toggleEditing'));
  const failedBranch = block.slice(block.indexOf('保存失败'), block.indexOf('} catch'));
  assert.doesNotMatch(failedBranch, /setEditing\(false\)/, '失败分支不得退出编辑');
});
