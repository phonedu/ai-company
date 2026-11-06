/**
 * RW-14（M5 真机带回，2026-10-27）· 频道范围落库＋note_write 读它定落点。
 *
 * 真机事实：范围选择器选了「周报助手」，note_write 却把笔记落到了**全局目录**（userData/notes/），
 * 幕僚长回复「记好了」未说明落点——老板会以为写进了项目。根因＝pi-assistant 装配时
 * `createNoteWriteTool(db, () => null)` 硬编码全局（占位注释「runTurn 时传入」从未接线）。
 * 修复口径：频道/项目树选项目时把 `channel.scope_project_id` 写进 settings（主进程可读），
 * note_write 的 scope getter 从 settings 读——0/缺省＝全局（公司范围口径不变）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openMemoryDatabase, runMigrations, readSetting, writeSetting } from '../src/main/db/index.js';
import { createNoteWriteTool } from '../src/main/agent/note-tools.js';
import type { SqliteDb } from '../src/main/db/index.js';

function fixture(): { db: SqliteDb; root: string; projA: string; projB: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), 'aico-rw14-'));
  const projA = join(root, 'proj-a');
  const projB = join(root, 'proj-b');
  mkdirSync(projA, { recursive: true });
  mkdirSync(projB, { recursive: true });
  const db = openMemoryDatabase();
  runMigrations(db);
  db.prepare('INSERT INTO projects(id, name, root_dir, created_at) VALUES(1, ?, ?, 1)').run('项目A', projA);
  db.prepare('INSERT INTO projects(id, name, root_dir, created_at) VALUES(2, ?, ?, 1)').run('项目B', projB);
  return { db, root, projA, projB, cleanup(): void { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

/** 模拟主进程装配的 scope getter：从 settings 读 channel.scope_project_id（与 pi-assistant 修复后一致）。 */
function scopeFromSettings(db: SqliteDb): number | null {
  const v = readSetting(db, 'channel.scope_project_id');
  return typeof v === 'number' && v > 0 ? v : null;
}

async function execute(tool: unknown, params: { name: string; content: string }): Promise<{ text: string }> {
  const t = tool as { execute(id: string, params: { name: string; content: string }): Promise<{ content: Array<{ text: string }> }> };
  const r = await t.execute('x', params);
  return { text: r.content[0]!.text };
}

test('RW-14①: 范围设置指向项目B → note_write 落项目B目录（不再落全局）', async () => {
  const f = fixture();
  try {
    writeSetting(f.db, 'channel.scope_project_id', 2);
    const tool = await createNoteWriteTool(f.db, () => scopeFromSettings(f.db));
    const r = await execute(tool, { name: 'meeting-note', content: '# 决定\n双周发布' });
    assert.match(r.text, /已存为当前项目笔记/, `应落项目（实际 ${r.text}）`);
    assert.ok(existsSync(join(f.projB, '.aico', 'notes', 'meeting-note.md')), '应写进项目B .aico/notes/');
    assert.match(readFileSync(join(f.projB, '.aico', 'notes', 'meeting-note.md'), 'utf8'), /双周发布/);
  } finally {
    f.cleanup();
  }
});

test('RW-14②: 范围为项目A → 落项目A（范围切换即换落点）', async () => {
  const f = fixture();
  try {
    writeSetting(f.db, 'channel.scope_project_id', 1);
    const tool = await createNoteWriteTool(f.db, () => scopeFromSettings(f.db));
    const r = await execute(tool, { name: 'scope-a', content: 'A' });
    assert.match(r.text, /已存为当前项目笔记/);
    assert.ok(existsSync(join(f.projA, '.aico', 'notes', 'scope-a.md')));
  } finally {
    f.cleanup();
  }
});

test('RW-14③: 无范围（公司口径）→ 回退全局目录（既有行为保留）', async () => {
  const f = fixture();
  const prevCwd = process.cwd();
  try {
    process.chdir(f.root); // 全局目录按 cwd 计算，隔离进临时目录
    const tool = await createNoteWriteTool(f.db, () => scopeFromSettings(f.db));
    const r = await execute(tool, { name: 'global-note', content: 'global' });
    assert.match(r.text, /已存为全局笔记/, `无范围应落全局（实际 ${r.text}）`);
    assert.ok(existsSync(join(f.root, '.aico-notes', 'notes', 'global-note.md')));
  } finally {
    process.chdir(prevCwd);
    f.cleanup();
  }
});
