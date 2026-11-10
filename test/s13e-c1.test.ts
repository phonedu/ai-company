/**
 *  P0/C1：归档项目必须弹选择卡（全部结束/保留暂停/先不归档），不再一键静默暂停。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync('src/renderer/components/ProjectOverview.tsx', 'utf8');
const ipc = readFileSync('src/main/ipc/ipc.ts', 'utf8');
const store = readFileSync('src/renderer/store.ts', 'utf8');

test('C1① 归档按钮打开选择卡（三个 testid 齐）', () => {
  assert.doesNotMatch(page, /onClick=\{\(\) => \{[\s\S]{0,120}archiveProject\(sessionSnap\.selectedProjectId\)/, '不得一键直归档');
  assert.match(page, /project-archive-finish-all/);
  assert.match(page, /project-archive-keep-paused/);
  assert.match(page, /project-archive-cancel/);
});

test('C1② 两种模式落到 IPC（finish_all→cancel；keep_paused→pause）', () => {
  assert.match(ipc, /input\.mode === 'finish_all'/);
  assert.match(ipc, /finishAll \? 'cancel' : 'pause'/);
  assert.match(store, /archiveProject\([\s\S]{0,80}mode: 'finish_all' \| 'keep_paused'/);
});
