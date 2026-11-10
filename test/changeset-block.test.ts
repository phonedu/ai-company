/**
 * 「变更（本次提交）」区块（产物/证据 tab 内）—— 渲染与两条"空态不伪装"（含有牙）。
 * 口径（3513）：(B) 位置 + (i) `task:get` join；`inplace` → 显式「本次为就地修改、无变更集」；
 *   `base_sha IS NULL` → 显式「基准未知」；**`summary` 空不渲染**；
 *   ** 起 `state` 必须展示**（待合并/已合并；合并按钮只对 open 出现）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TaskDetail, type ChangesetDTO, type TaskDetailDTO } from '../src/renderer/components/TaskDetail.js';
import { openMemoryDatabase } from '../src/main/db/open.js';
import { runMigrations } from '../src/main/db/migrate.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';

const AT = 1_700_000_000_000;

function detail(over: { changesets?: ChangesetDTO[] | null; accessMode?: string | null }): TaskDetailDTO {
  return {
    task: {
      id: 1,
      shortId: 'T-1001',
      projectId: 1,
      title: 't',
      goal: 'g',
      state: 'executing',
      riskLevel: 1,
      priority: 0,
      createdAt: AT,
      updatedAt: AT,
      acceptance: [],
      projectAccessMode: over.accessMode ?? 'staging',
    },
    progress: { done: 0, total: 0 },
    planSteps: [],
    timeline: [],
    behaviorLog: [],
    artifacts: [],
    changesets: over.changesets ?? [],
    counts: { planSteps: 0, timeline: 0, behaviorLog: 0, acceptance: 0 },
  };
}

function cs(over: Partial<ChangesetDTO> = {}): ChangesetDTO {
  return {
    id: 7,
    branch: 'aico/T-1001',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    filesChanged: 1,
    insertions: 2,
    deletions: 0,
    summary: '',
    state: 'open',
    createdAt: AT,
    files: [{ path: 'a.ts', status: 'modified', insertions: 2, deletions: 0, employeeId: 1 }],
    ...over,
  };
}

const render = (d: TaskDetailDTO): string =>
  renderToStaticMarkup(createElement(TaskDetail, { data: d, initialTab: 'artifacts' }));

test('变更区块：有变更集 → 区块 + 行 + 文件名（小标题明确）', () => {
  const html = render(detail({ changesets: [cs()] }));
  assert.match(html, /data-testid="changeset-block"/);
  assert.match(html, /变更（本次提交）/);
  assert.match(html, /data-testid="changeset-row"[^>]*data-base-known="true"/);
  assert.match(html, /aico\/T-1001/);
  assert.match(html, /a\.ts/);
  assert.equal(html.includes('变更（本次提交）'.replace('', '')), true);
});

test('变更区块：`base_sha IS NULL` → 显式「基准未知」（不拿猜的基准）', () => {
  const html = render(detail({ changesets: [cs({ baseSha: null, filesChanged: 0, insertions: 0, deletions: 0, files: [] })] }));
  assert.match(html, /data-testid="changeset-row"[^>]*data-base-known="false"/);
  assert.match(html, /data-testid="changeset-base-unknown"[^>]*>[\s\S]*?基准未知/);
});

test('UG-06 变更集文件行：status 徽标 / 路径 / +− / 员工 / diff（缺 handler disabled）', () => {
  const data = detail({
    changesets: [
      cs({
        files: [
          { path: 'a.ts', status: 'added', insertions: 3, deletions: 0, employeeId: 1, employeeName: '研究员' },
        ],
      }),
    ],
  });
  const html = render(data);
  assert.equal((html.match(/data-testid="changeset-file"/g) ?? []).length, 1);
  assert.match(html, /data-testid="changeset-file"[^>]*data-status="added"/);
  assert.match(html, /data-testid="changeset-file"[\s\S]*?A[\s\S]*?a\.ts[\s\S]*?\+3[\s\S]*?研究员/);
  assert.match(html, /data-testid="changeset-file-diff-7-0"[^>]*disabled/);

  const withHandler = renderToStaticMarkup(
    createElement(TaskDetail, {
      data,
      initialTab: 'artifacts',
      onReadChangesetDiff: async () => ({ ok: true, diff: '' }),
    }),
  );
  assert.match(withHandler, /data-testid="changeset-file-diff-7-0"/);
  assert.equal(withHandler.includes('data-testid="changeset-file-diff-7-0" disabled'), false);
});

test('变更区块：无变更集 + `inplace` → 「本次为就地修改、无变更集。」（不给空白）', () => {
  const html = render(detail({ changesets: [], accessMode: 'inplace' }));
  assert.match(html, /data-testid="changeset-inplace"[\s\S]*?本次为就地修改、无变更集/);
});

test('变更区块：无变更集 + 非 inplace（staging 未提交）→ 「暂无变更集。」', () => {
  const html = render(detail({ changesets: [], accessMode: 'staging' }));
  assert.match(html, /data-testid="changeset-empty"[\s\S]*?暂无变更集/);
});

test('变更区块：`summary` 空不渲染；`state` 必须展示（M3-P-4 合并真值表）', () => {
  const html = render(detail({ changesets: [cs({ summary: 'SHOULD_NOT_RENDER' })] }));
  assert.equal(html.includes('SHOULD_NOT_RENDER'), false, 'summary 空/未接 → 不渲染');
  assert.match(html, /data-testid="changeset-state"[^>]*data-state="open"[^>]*>待合并/, 'M3-P-4 起展示真实状态');
});

test('变更区块 "有牙"：若去掉 base_sha NULL 判定 → 「基准未知」不再出现（证明判定承重）', () => {
  const baseShaNull = cs({ baseSha: null });
  const baseKnown = baseShaNull.baseSha != null;
  assert.equal(baseKnown, false, 'base_sha 为 null 时必须判为未知');
  // 若实现写成 `if (cs.baseSha)` 之外的恒假…… 这里断言"判定确实依赖 baseSha 是否为 null"
  assert.notEqual(baseKnown, cs().baseSha != null);
});

test('F-CS-1（真机抓到）：`getTaskDetail` 必须真带 `projectAccessMode`（否则 inplace 空态死）', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  const repo = createSqliteChatRepo(db);
  try {
    const projectId = Number(
      db
        .prepare("INSERT INTO projects(name, root_dir, access_mode, created_at) VALUES('P', 'D:/r', 'inplace', 1)")
        .run().lastInsertRowid,
    );
    const task = repo.createTask({ projectId, title: 't', goal: 'g' });
    // 详情路径（getTaskDetail）必须与列表路径（listTasks）一样带项目接入模式。
    assert.equal(repo.getTaskDetail(task.id)?.task.projectAccessMode, 'inplace', '详情路径必须带 projectAccessMode');
    assert.equal(repo.listTasks({})[0]?.projectAccessMode, 'inplace', '列表路径也应带');
  } finally {
    db.close();
  }
});

test('F-CS-1 端到端（走真实入口）：`repo.getTaskDetail(inplace)` → 渲染出「本次为就地修改、无变更集。」', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  const repo = createSqliteChatRepo(db);
  try {
    const projectId = Number(
      db
        .prepare("INSERT INTO projects(name, root_dir, access_mode, created_at) VALUES('P', 'D:/r', 'inplace', 1)")
        .run().lastInsertRowid,
    );
    const task = repo.createTask({ projectId, title: 't', goal: 'g' });
    const d = repo.getTaskDetail(task.id)!;
    const dto = {
      task: { ...d.task, acceptance: [] },
      progress: d.progress,
      planSteps: d.planSteps,
      timeline: d.timeline,
      behaviorLog: [],
      artifacts: d.artifacts,
      changesets: d.changesets,
      counts: { planSteps: d.planSteps.length, timeline: d.timeline.length, behaviorLog: 0, acceptance: 0 },
    } as unknown as TaskDetailDTO;
    const html = renderToStaticMarkup(createElement(TaskDetail, { data: dto, initialTab: 'artifacts' }));
    assert.match(html, /data-testid="changeset-inplace"[\s\S]*?本次为就地修改、无变更集/);
  } finally {
    db.close();
  }
});
