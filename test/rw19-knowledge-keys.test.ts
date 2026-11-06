/**
 * RW-19 回归（M5 真实项目测试 S9 批，2026-10-28）：知识页列表键唯一性。
 *
 * 缺陷：键＝`projectId-name`，周报助手项目里有两份同名 README（`.aico/docs/README.md` 文档
 * ＋根目录 `README.md` 产物）→ 同键兄弟节点 → React 对账行为未定义 → 旧 DOM 残留：
 * 搜索过滤后幻影卡片常驻（甚至与「没有匹配的内容」空态并存）。真机 CDP fiber 对质实锤
 * （幻影节点 index=11＝全量数组末位，提交树只有当前过滤结果）。
 *
 * 修法：键改含 type＋path（文件全路径唯一）。
 * 判据：① 同项目同名不同类型/路径 → 键不同；② 全量条目两两不重。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { knowledgeItemKey } from '../src/renderer/components/knowledge-types.js';
import type { NoteItem } from '../src/renderer/components/knowledge-types.js';

function item(partial: Partial<NoteItem> & { name: string; type: NoteItem['type']; path: string }): NoteItem {
  return { lines: 1, updatedAt: 0, preview: '', projectName: 'p', projectId: 2, ...partial };
}

test('RW-19① 同项目同名不同类型/路径 → 键不同', () => {
  const doc = item({ name: 'README', type: 'doc', path: 'C:/p/.aico/docs/README.md' });
  const artifact = item({ name: 'README', type: 'artifact', path: 'C:/p/README.md' });
  assert.notEqual(knowledgeItemKey(doc), knowledgeItemKey(artifact));
});

test('RW-19② 全量条目（含双 README 与全局项）两两不重', () => {
  const items: NoteItem[] = [
    item({ name: 'README', type: 'doc', path: 'C:/p/.aico/docs/README.md' }),
    item({ name: 'README', type: 'artifact', path: 'C:/p/README.md' }),
    item({ name: 'README', type: 'doc', path: 'C:/q/.aico/docs/README.md', projectId: 3 }),
    item({ name: 'README', type: 'note', path: 'C:/g/notes/README.md', projectId: null, projectName: null }),
    item({ name: 's9-格式全测', type: 'note', path: 'C:/g/notes/s9-格式全测.md', projectId: null, projectName: null }),
  ];
  const keys = items.map(knowledgeItemKey);
  assert.equal(new Set(keys).size, keys.length);
});
