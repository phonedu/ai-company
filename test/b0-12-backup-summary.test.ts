/**
 * B0-12（57 D 路 P2）：迁移前无自动备份、changeset/commit message 无语义的回归测试。
 *
 * 旧实现：
 *  - `backupDatabase`（VACUUM INTO）全仓零调用；迁移失败仅 console 后继续开窗——迁移一旦写坏
 *    真实库，老板没有可回退的副本。
 *  - `finishWorkspace` 的 commit message 是模板 `${shortId}: work item ${id}`；changeset `summary: ''`
 *    （schema 注释承诺的「人话摘要」是空头支票）。
 *
 * 新口径：库非空且有未应用迁移时先备份到 `<dataDir>/backups/`（保留最近 3 份），备份失败拒绝继续；
 * commit/changeset 摘要取员工 `submit_work_item.summary`（截断），无摘要时明说「未提供摘要」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase, runMigrations } from '../src/main/db/index.js';
import { backupBeforeMigration } from '../src/main/db/startup-backup.js';
import { changesetSummary, workItemCommitMessage } from '../src/main/engine/commit-message.js';

test('B0-12：有未应用迁移时先备份（VACUUM INTO），保留最近 3 份', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aico-backup-'));
  try {
    const dbFile = join(dir, 'aico.sqlite');
    const db = openDatabase(dbFile);
    runMigrations(db);
    db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/p',1)").run();
    const current = db.pragma('user_version', { simple: true }) as number;
    // 模拟「库落后一版」：把 latest 报成 current+1。
    const res = backupBeforeMigration(db, { dataDir: dir, latestVersion: current + 1, now: 1_700_000_000_000 });
    assert.ok(res.path, `必须生成备份（实际：${JSON.stringify(res)}）`);
    assert.ok((res.bytes ?? 0) > 0);
    assert.match(res.reason, /backed_up/);
    const backups = readdirSync(join(dir, 'backups')).filter((f) => f.endsWith('.sqlite'));
    assert.equal(backups.length, 1);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('B0-12：库已是最新 / 空库 → 不备份（不制造噪音副本）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aico-backup-'));
  try {
    const db = openDatabase(join(dir, 'aico.sqlite'));
    runMigrations(db);
    const current = db.pragma('user_version', { simple: true }) as number;
    const upToDate = backupBeforeMigration(db, { dataDir: dir, latestVersion: current });
    assert.equal(upToDate.path, null);
    assert.equal(upToDate.reason, 'up_to_date');
    db.close();
    // 空库（没跑迁移）不备份
    const empty = openDatabase(join(dir, 'empty.sqlite'));
    const emptyRes = backupBeforeMigration(empty, { dataDir: dir, latestVersion: 99 });
    assert.equal(emptyRes.path, null);
    assert.equal(emptyRes.reason, 'empty_db');
    empty.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('B0-12：备份保留 3 份（旧的自动清理，不无限膨胀）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aico-backup-'));
  try {
    const db = openDatabase(join(dir, 'aico.sqlite'));
    runMigrations(db);
    const current = db.pragma('user_version', { simple: true }) as number;
    mkdirSync(join(dir, 'backups'), { recursive: true });
    for (let i = 0; i < 3; i += 1) {
      writeFileSync(join(dir, 'backups', `aico-before-v1-2000010${i}-000000.sqlite`), 'old');
    }
    backupBeforeMigration(db, { dataDir: dir, latestVersion: current + 1, now: 1_700_000_000_000, keep: 3 });
    const backups = readdirSync(join(dir, 'backups')).filter((f) => f.endsWith('.sqlite'));
    assert.equal(backups.length, 3, `只保留最近 3 份（实际 ${JSON.stringify(backups)}）`);
    assert.ok(backups.some((f) => f.includes('aico-before-v')), '新备份在场');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('B0-12：commit message 带任务短号＋摘要（不再是 `work item N` 模板）', () => {
  const msg = workItemCommitMessage({
    shortId: 'T-1042',
    title: '项目页行下展开',
    summary: '把任务行改为行下展开；补 Esc 回焦与深链。',
    workItemId: 7,
  });
  assert.match(msg, /^T-1042: 项目页行下展开 — 把任务行改为行下展开/);
  assert.equal(msg.includes('work item 7'), false, '不得再出现模板占位');
  const fallback = workItemCommitMessage({ shortId: 'T-1', title: '任务', summary: null, workItemId: 9 });
  assert.match(fallback, /^T-1: 任务/);
  assert.match(fallback, /未提供摘要/, '无摘要要明说（不假装有）');
});

test('B0-12：changeset 摘要取员工提交摘要；无摘要写明文件数', () => {
  assert.equal(changesetSummary({ summary: '修好空态', filesChanged: 3 }), '修好空态');
  assert.match(changesetSummary({ summary: '', filesChanged: 4 }), /未提供摘要（4 个文件变化）/);
});
