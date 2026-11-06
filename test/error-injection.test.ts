/**
 * 2026-11-03（逐页错误注入）：注入 IPC 失败时，页面必须可见、可重试，不伪装成空。
 *
 * 真机注入（AICO_FAULT_CHANNELS + 非打包态 allowFaultInjection）发现并修复：
 *  - 项目树/归档：project:list/task:list 失败时显示「0 个项目 / 暂无归档」（假空态）；
 *  - 笔记：notes:list 失败时显示「没有匹配的内容」；
 *  - 设置：只有一行错误、无重试，且旧值仍像最新值；
 *  - 频道/待我处理/大厅/任务详情：原有错误态可见（通过）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const store = readFileSync('src/renderer/store.ts', 'utf8');
const projects = readFileSync('src/renderer/components/ProjectsPage.tsx', 'utf8');
const list = readFileSync('src/renderer/components/TaskListViews.tsx', 'utf8');
const notes = readFileSync('src/renderer/components/KnowledgePage.tsx', 'utf8');
const settings = readFileSync('src/renderer/components/SettingsPane.tsx', 'utf8');
const ipc = readFileSync('src/main/ipc/ipc.ts', 'utf8');
const main = readFileSync('src/main/index.ts', 'utf8');

test('任务列表加载失败：store 置 error（不静默），项目树/归档都有错误块＋重试', () => {
  assert.match(store, /tasks\.error = error instanceof Error \? error\.message : String\(error\)/);
  assert.match(projects, /data-testid="projects-load-error"/);
  assert.match(projects, /data-testid="projects-load-retry"/);
  assert.match(list, /data-testid="ptree-error"/);
  assert.match(list, /data-testid="archive-error"/);
  assert.match(list, /data-testid="archive-error-retry"/);
});

test('笔记列表加载失败：不再显示「没有匹配」而是错误＋重试', () => {
  assert.match(store, /notesStore\.error = error instanceof Error \? error\.message : String\(error\)/);
  assert.match(notes, /data-testid':\s*'knowledge-load-error'|data-testid="knowledge-load-error"/);
  assert.match(notes, /data-testid':\s*'knowledge-load-retry'|data-testid="knowledge-load-retry"/);
  assert.match(notes, /notesSnap\.error != null/);
});

test('设置加载失败：错误可重试并提示旧值可能过期', () => {
  assert.match(settings, /data-testid="settings-error-retry"/);
  assert.match(settings, /以下数值可能不是最新/);
});

test('故障注入仅非打包态 + 显式 env 生效（生产恒 false）', () => {
  assert.match(ipc, /allowFaultInjection === true \? \(process\.env\.AICO_FAULT_CHANNELS/);
  assert.match(ipc, /throw new Error\(`注入故障：\$\{channel\}`\)/);
  assert.match(main, /allowFaultInjection: !app\.isPackaged/);
});
