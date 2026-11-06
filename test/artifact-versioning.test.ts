/**
 * 产物「同路径多版本」语义（老板 2026-11-05 真机截图：同一 `docs/specs/*.md` 出现两行，
 * 一行带 ⚠️「与记录不一致」——看着像故障，实际是**两个工作项各提交了一次**）。
 *
 * 根因：`insertArtifact` 幂等键 = `(task_id, work_item_id, path)` ⇒ 不同工作项同路径各留一行；
 * 先产出的那行 sha256 记录的是当时版本，文件后来被改 ⇒ 读时 `sha256Mismatch=true`（设计如此：
 * 指纹防「汇报后又被改」）。问题在**表达**：旧版本与真异常混为一谈。
 *
 * 本批判据：
 *  ① `handleReadArtifact` 对「同任务同路径存在更晚产出」的旧行返回 `supersededBy`（id/时间）；
 *  ② 抽屉里旧版本显示「旧版本（已被后续产出覆盖）」而不是 ⚠️ 与记录不一致；
 *  ③ 真异常（最新版本指纹与盘上不符）仍显示 ⚠️；
 *  ④ 产物列表按路径分组：默认只显示最新一条，旧版本收进「历史版本（N）」可展开。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { insertArtifact, openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleReadArtifact } from '../src/main/ipc/ipc.js';
import type { IpcDeps } from '../src/main/ipc/ipc.js';
import { TaskDetail, type TaskDetailDTO } from '../src/renderer/components/TaskDetail.js';

const sha256hex = (s: string): string => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

interface Fx {
  dir: string;
  root: string;
  db: ReturnType<typeof openMemoryDatabase>;
  deps: IpcDeps;
  v1: number;
  v2: number;
}
const PATH = 'docs/specs/分析.md';

function seed(): Fx {
  const dir = mkdtempSync(join(tmpdir(), 'aico-artver-'));
  const root = join(dir, 'proj');
  mkdirSync(join(root, 'docs', 'specs'), { recursive: true });
  const db = openMemoryDatabase();
  runMigrations(db);
  const now = Date.now();
  db.prepare('INSERT INTO employees(id, name, role, created_at) VALUES (1, ?, ?, ?)').run('员工', '工程师', now);
  db.prepare('INSERT INTO projects (id, name, root_dir, created_at) VALUES (1, ?, ?, ?)').run('甲项目', root, now);
  db.prepare(
    "INSERT INTO tasks (id, short_id, title, goal, acceptance, state, project_id, created_at, updated_at) VALUES (11, 'T-1', 't', 'g', '[]', 'executing', 1, ?, ?)",
  ).run(now, now);
  db.prepare(
    "INSERT INTO work_items (id, task_id, employee_id, title, brief, state, created_at) VALUES (1, 11, 1, '实现', 'b', 'done', ?)",
  ).run(now);
  db.prepare(
    "INSERT INTO work_items (id, task_id, employee_id, title, brief, state, created_at) VALUES (2, 11, 1, '修复', 'b', 'done', ?)",
  ).run(now);
  const v1Text = '# 版本一\n';
  writeFileSync(join(root, PATH), v1Text, 'utf8');
  const v1 = insertArtifact(db, { taskId: 11, workItemId: 1, path: PATH, kind: 'file', sha256: sha256hex(v1Text), now: now - 600000 }).id;
  const v2Text = '# 版本二（当前）\n';
  writeFileSync(join(root, PATH), v2Text, 'utf8');
  const v2 = insertArtifact(db, { taskId: 11, workItemId: 2, path: PATH, kind: 'file', sha256: sha256hex(v2Text), now }).id;
  const deps: IpcDeps = { repo: createSqliteChatRepo(db), db };
  return { dir, root, db, deps, v1, v2 };
}
function cleanup(f: Fx): void {
  f.db.close();
  rmSync(f.dir, { recursive: true, force: true });
}

test('① 旧版本读：返回 supersededBy（被哪个更新产出覆盖）', async () => {
  const f = seed();
  try {
    const old = await handleReadArtifact(f.deps, { artifactId: f.v1 });
    assert.equal(old.ok, true);
    if (!old.ok || old.mode !== 'read') return assert.fail('应为 read 回执');
    assert.equal(old.sha256Mismatch, true, '旧版本指纹与盘上不一致＝事实');
    assert.ok(old.supersededBy, '必须如实给出「被后续产出覆盖」的指向');
    assert.equal(old.supersededBy?.artifactId, f.v2);
  } finally {
    cleanup(f);
  }
});

test('② 最新版本读：无 supersededBy、指纹一致（真异常才配 ⚠️）', async () => {
  const f = seed();
  try {
    const latest = await handleReadArtifact(f.deps, { artifactId: f.v2 });
    assert.equal(latest.ok, true);
    if (!latest.ok || latest.mode !== 'read') return assert.fail('应为 read 回执');
    assert.equal(latest.supersededBy ?? null, null);
    assert.equal(latest.sha256Mismatch, false);
  } finally {
    cleanup(f);
  }
});

// ── UI：列表分组＋抽屉标签（SSR） ──

function detail(artifacts: Array<Record<string, unknown>>): TaskDetailDTO {
  return {
    task: { id: 11, shortId: 'T-1', projectId: 1, title: 't', goal: 'g', state: 'executing', riskLevel: 1, priority: 0, createdAt: 1, updatedAt: 1, acceptance: [] },
    progress: { done: 0, total: 0 },
    planSteps: [],
    timeline: [],
    behaviorLog: [],
    artifacts,
    counts: { planSteps: 0, timeline: 0, behaviorLog: 0, acceptance: 0 },
  } as unknown as TaskDetailDTO;
}

const art = (id: number, at: number, wi: number | null) => ({ id, kind: 'file', name: '分析.md', path: PATH, sha256: 'f'.repeat(12), source: null, commit: null, workItemId: wi, at });

test('④ 列表分组：同路径两版本 → 默认只渲染最新一行；旧版本收进「历史版本（1）」', () => {
  const html = renderToStaticMarkup(
    createElement(TaskDetail, {
      data: detail([art(1, 1000, 1), art(2, 2000, 2)]),
      initialTab: 'artifacts',
    } as never),
  );
  const rows = (html.match(/data-testid="artifact-item"/g) ?? []).length;
  assert.equal(rows, 1, `默认只渲染最新一行（实际 ${rows} 行）`);
  assert.match(html, /data-testid="artifact-history-toggle"[^>]*>历史版本（1）/, '旧版本必须有「历史版本（1）」入口');
  assert.match(html, /data-artifact-id="2"/, '最新版本（id=2）在前台');
});

test('④ 无多版本时：不出现「历史版本」入口（不摆空壳）', () => {
  const html = renderToStaticMarkup(
    createElement(TaskDetail, {
      data: detail([art(3, 3000, 1)]),
      initialTab: 'artifacts',
    } as never),
  );
  assert.equal(html.includes('artifact-history-toggle'), false);
});

test('② 抽屉：旧版本显示「旧版本」语义而不是 ⚠️ 与记录不一致', () => {
  const html = renderToStaticMarkup(
    createElement(TaskDetail, {
      data: detail([art(1, 1000, 1), art(2, 2000, 2)]),
      artifactPreview: {
        artifactId: 1,
        name: '分析.md',
        path: PATH,
        size: 20,
        sha256: 'a'.repeat(64),
        sha256Mismatch: true,
        text: '# 版本一\n',
        truncated: false,
        supersededBy: { artifactId: 2, createdAt: 2000 },
      },
      initialTab: 'artifacts',
    } as never),
  );
  assert.match(html, /旧版本（已被 #[0-9]+ 覆盖）/, '旧版本要有明确人话标签');
  assert.match(html, /data-testid="artifact-preview-note"[^>]*>[^<]*不是当时的版本内容/, '必须写明「下面是当前内容、非当时版本」');
  assert.equal(html.includes('与记录不一致'), false, '旧版本不得再报「与记录不一致」');
});

test('③ 抽屉：最新版本指纹不符仍报 ⚠️ 与记录不一致（真异常不放过）', () => {
  const html = renderToStaticMarkup(
    createElement(TaskDetail, {
      data: detail([art(4, 4000, 1)]),
      artifactPreview: {
        artifactId: 4,
        name: '分析.md',
        path: PATH,
        size: 20,
        sha256: 'b'.repeat(64),
        sha256Mismatch: true,
        text: '# x\n',
        truncated: false,
      },
      initialTab: 'artifacts',
    } as never),
  );
  assert.match(html, /与记录不一致/, '最新版本指纹不符必须继续显式告警');
});
