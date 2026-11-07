/**
 * B0-6（ADV-1 P0-4/5）：记忆中文检索断裂 + 无 key 写入零去重的回归测试。
 *
 * 旧实现：
 *  - `queryTerms` 只按空白切词（中文整句＝一个词）⇒ LIKE `%整句%` 命中不了；
 *    LIKE 兜底只用 `terms[0]`，命中后还要求**全部**词在场 ⇒ 中文任务记忆检索段几乎必空。
 *  - 合并/冲突只认 `key != null`，而三条生产写路径 key 都是 null ⇒ 同一事实重说=新行，库无限膨胀。
 *
 * 新口径：检索词复用 `retrievalTerms`（中文 2 字滑窗），LIKE 预筛用前几个词 OR、命中按「命中词数」
 * 计分（命中即召回，不再要求全部在场）；无 key 写入先做**同 scope+kind 同值近似去重**（归一空白/大小写）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDatabase, runMigrations, type SqliteDb } from '../src/main/db/index.js';
import { SqliteMemoryStore } from '../src/main/memory/index.js';

function fresh(): { db: SqliteDb; store: SqliteMemoryStore; project: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const project = Number(
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/p',1)").run().lastInsertRowid,
  );
  return { db, store: new SqliteMemoryStore(db), project };
}

const boss = (ref = 'boss:1') => ({ type: 'boss' as const, ref });

test('B0-6：中文整句查询能召回（2 字滑窗 + 命中即召回）', () => {
  const { db, store, project } = fresh();
  try {
    store.remember({
      scope: { type: 'project', projectId: project },
      kind: 'fact',
      key: 'perf.first-paint',
      value: '笔记页首屏 820ms，主因是面板渲染阻塞',
      source: boss(),
      now: 100,
    });
    const hits = store.search({
      scope: { type: 'project', projectId: project },
      text: '修渲染问题',
      principal: { kind: 'assistant' },
    });
    assert.equal(hits.length, 1, '中文查询必须能命中（旧实现整句 LIKE，永远 0 条）');
    assert.equal(hits[0]!.item.key, 'perf.first-paint');
  } finally {
    db.close();
  }
});

test('B0-6：命中词数评分——命中一个中文 2-gram 也召回，多命中排前', () => {
  const { db, store, project } = fresh();
  try {
    const scope = { type: 'project' as const, projectId: project };
    store.remember({ scope, kind: 'fact', key: 'a', value: '对账单以万元为单位', source: boss(), now: 100 });
    store.remember({ scope, kind: 'fact', key: 'b', value: '账单口径：含税金额', source: boss(), now: 101 });
    store.remember({ scope, kind: 'fact', key: 'c', value: '无关内容：发布节奏', source: boss(), now: 102 });
    const hits = store.search({ scope, text: '账单口径', principal: { kind: 'assistant' } });
    assert.ok(hits.length >= 1, '至少命中含「账单」的条目');
    assert.ok(
      hits.every((h) => h.item.value.includes('账')),
      '不相关条目不得混入',
    );
    assert.equal(hits[0]!.item.key, 'b', '命中词更多的排前（口径+账单）');
  } finally {
    db.close();
  }
});

test('B0-6：无 key 写入做近似去重（同值重说不新增行，只刷新时间）', () => {
  const { db, store, project } = fresh();
  try {
    const scope = { type: 'project' as const, projectId: project };
    const first = store.remember({
      scope,
      kind: 'fact',
      value: '客户把「对账单」叫月结单',
      source: { type: 'assistant', ref: 'T-1001' },
      now: 100,
    });
    const again = store.remember({
      scope,
      kind: 'fact',
      value: '  客户把「对账单」叫月结单  ',
      source: { type: 'assistant', ref: 'T-1002' },
      now: 200,
    });
    assert.equal(again.id, first.id, '同值重说必须幂等（旧实现 key=null 直接插新行）');
    assert.equal(store.list({ scope }).length, 1, '库内只应有一行');
    assert.equal(store.get(first.id)?.updatedAt, 200, '刷新 updated_at（表示再次被确认）');
  } finally {
    db.close();
  }
});

test('B0-6：近似去重不误伤——不同值仍各自成行（不静默覆盖）', () => {
  const { db, store, project } = fresh();
  try {
    const scope = { type: 'project' as const, projectId: project };
    store.remember({ scope, kind: 'fact', value: '发布节奏：双周', source: boss('T-1'), now: 100 });
    store.remember({ scope, kind: 'fact', value: '发布节奏：每月', source: boss('T-2'), now: 101 });
    assert.equal(store.list({ scope }).length, 2, '不同值不得被去重吞掉（矛盾留给 B3-5 裁决）');
  } finally {
    db.close();
  }
});
