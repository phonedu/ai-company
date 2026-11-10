/**
 *  尾批·幕僚长 `memory_search` 工具（跨范围只读检索）。
 *
 * 背景（2026-11-05 裁「1 和 2 都做」）：幕僚长 brief 只注入 global＋当前项目两节；
 * 「别的项目里记过什么」检索不到 ⇒ 只读工具走 `SqliteMemoryStore.search`（全局＋全部活跃项目），
 * 不动 brief 结构、不动隔离边界（员工侧不加、不写任何数据）。
 *
 * 判据：跨项目命中带范围标签 / 空结果明说不臆造 / 架构条目不出现 / 条数封顶。
 * 不碰真实数据：全部内存库。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDatabase, runMigrations, type SqliteDb } from '../src/main/db/index.js';
import { SqliteMemoryStore } from '../src/main/memory/index.js';
import { createMemorySearchTool } from '../src/main/agent/memory-search-tool.js';

function fresh(): { db: SqliteDb; store: SqliteMemoryStore; projectA: number; projectB: number } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const projectA = Number(db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('像素编辑器','D:/a',1)").run().lastInsertRowid);
  const projectB = Number(db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('周报助手','D:/b',1)").run().lastInsertRowid);
  return { db, store: new SqliteMemoryStore(db), projectA, projectB };
}

const boss = (ref = 'boss:1') => ({ type: 'boss' as const, ref });

async function toolText(db: SqliteDb, query: string): Promise<{ text: string; details: unknown }> {
  const tool = await createMemorySearchTool(db);
  const result = (await tool.execute('call_1', { query }, undefined, undefined, {} as never)) as {
    content: Array<{ type: string; text: string }>;
    details: unknown;
  };
  return { text: result.content.map((b) => b.text).join(''), details: result.details };
}

test('memory_search: 跨项目命中——A 项目的事实按范围标签回给幕僚长', async () => {
  const { db, store, projectA } = fresh();
  try {
    store.remember({
      scope: { type: 'project', projectId: projectA },
      kind: 'fact',
      key: 'pkg.manager',
      value: '像素编辑器仓库用 pnpm 管依赖',
      source: boss('T-2001'),
      now: 100,
    });
    const { text } = await toolText(db, 'pnpm 依赖');
    assert.ok(text.includes('像素编辑器'), `必须带项目名标签（结果：${text}）`);
    assert.ok(text.includes('pnpm'), '必须含命中值');
  } finally {
    db.close();
  }
});

test('memory_search: 全局条目带[全局]标签；多范围命中合并回给', async () => {
  const { db, store, projectA } = fresh();
  try {
    const g = store.remember({
      scope: { type: 'global' },
      kind: 'preference',
      key: 'release.bar',
      value: '发布前必须跑全量测试',
      source: boss('boss:2'),
      now: 101,
    });
    store.remember({
      scope: { type: 'project', projectId: projectA },
      kind: 'fact',
      value: '发布清单在 docs/release.md',
      source: boss('T-2002'),
      now: 102,
    });
    const { text } = await toolText(db, '发布');
    assert.ok(text.includes('[全局]'), `全局条目必须带[全局]标签（结果：${text}）`);
    assert.ok(text.includes('像素编辑器'), '项目命中也要在（跨范围合并）');
    assert.ok(text.includes(g.value), 'global 值必须在');
  } finally {
    db.close();
  }
});

test('memory_search: 空结果明说没搜到（不臆造、不编条目）', async () => {
  const { db } = fresh();
  try {
    const { text } = await toolText(db, '完全不存在的关键词量子');
    assert.ok(/没搜到|无相关/.test(text), `空结果必须明说（结果：${text}）`);
    assert.ok(!/像素编辑器/.test(text), '无命中不得罗列无关条目');
  } finally {
    db.close();
  }
});

test('memory_search: 已归档/被接替的条目不回给（只回 active）', async () => {
  const { db, store, projectA } = fresh();
  try {
    const it = store.remember({
      scope: { type: 'project', projectId: projectA },
      kind: 'fact',
      value: '旧的部署方式是 FTP',
      source: boss('T-2003'),
      now: 100,
    });
    store.forget(it.id, 'archive');
    const { text } = await toolText(db, 'FTP 部署');
    assert.ok(/没搜到|无相关/.test(text), '归档条目不得命中');
  } finally {
    db.close();
  }
});

test('memory_search: 命中过多封顶（防一次灌爆幕僚长上下文）', async () => {
  const { db, store, projectA } = fresh();
  try {
    for (let i = 0; i < 12; i += 1) {
      store.remember({
        scope: { type: 'project', projectId: projectA },
        kind: 'fact',
        value: `性能基线记录第${i}条：首屏 800ms`,
        source: boss(`T-3${String(i).padStart(2, '0')}`),
        now: 100 + i,
      });
    }
    const { text, details } = await toolText(db, '性能 基线');
    const lines = text.split('\n').filter((l) => l.trim().startsWith('- '));
    assert.ok(lines.length <= 8, `最多 8 条（实际 ${lines.length}）`);
    assert.ok(details != null, 'details 带结构化读数');
  } finally {
    db.close();
  }
});
