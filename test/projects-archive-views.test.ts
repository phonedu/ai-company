/**
 * 项目树页 / 归档页（2026-10-18 改页批；决定「站在导航栏的就是导航，就该开一个页面」）——判据：
 *   ① 纯视图（props 进 DOM 出）：项目树＝按项目归并（组题可点→概览；行→详情；空态）；归档＝归档行列表
 *      （计数/空态/只列 archived=1）；
 *   ② 行＝状态点（语义色）＋短号＋题＋头像（与左栏同款 `taskVisuals`）；
 *   ③ 源码守门：左栏两导航项＝**视图切换**（`showProjectTree`/`showArchive`），开关语义退役
 *      （`showProjects/showArchived/toggle*` 全仓 0 处）；壳路由两页到场；视图游标白名单含两页。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ArchiveView, filterArchivedTasks, ProjectsList, TaskListItem } from '../src/renderer/components/TaskListViews.js';
import { archivedProjectsFromList, projectsFromList, projectsFromTasks } from '../src/renderer/components/projectView.js';
import type { ProjectDTO, TaskDTO } from '../src/renderer/types.js';

const AT = 1_700_000_000_000;

function task(over: Partial<TaskDTO> & { id: number }): TaskDTO {
  return {
    shortId: `T-10${over.id}`,
    projectId: 1,
    title: '演示任务',
    state: 'executing',
    priority: 0,
    riskLevel: 1,
    createdAt: AT,
    readySince: null,
    acceptance: [],
    archived: 0,
    projectName: '记账系统',
    projectAlias: null,
    projectAccessMode: 'inplace',
    ...over,
  } as TaskDTO;
}

const TASKS: TaskDTO[] = [
  task({
    id: 1,
    projectId: 1,
    projectName: '记账系统',
    state: 'executing',
    executor: { id: 2, name: '研究员' },
    waits: [{ workItemId: null, reason: 'no_slot', detail: '槽位 3/3' }],
  }),
  task({ id: 2, projectId: 1, projectName: '记账系统', state: 'done' }),
  task({ id: 3, projectId: 2, projectName: '官网', state: 'ready' }),
  task({ id: 4, projectId: 1, projectName: '记账系统', state: 'done', archived: 1 }),
];

test('归档回执有消费者：ProjectOverview 渲染 tasks.notice（左栏任务行退役后不静默消失）', () => {
  const source = readFileSync('src/renderer/components/ProjectOverview.tsx', 'utf8');
  assert.ok(source.includes('tasksSnap.notice'), '归档回执未渲染（tasks.notice 无消费者）');
  assert.ok(source.includes('data-testid="project-task-notice"'), '缺归档回执 testid');
  // 项目树任务行显示引擎 waits（空则不摆占位）。
  assert.ok(source.includes('waitingSummary(task.waits)'), '项目树任务行未消费 task.waits');
  assert.ok(source.includes('data-testid="project-task-wait"'), '缺项目树等待原因 testid');
});

test('项目树页（双栏批）：左列项目行＝名＋任务数（归档行不计）；选中 aria-current；点＝切换右栏', () => {
  const groups = projectsFromTasks(TASKS.filter((t) => t.archived !== 1));
  assert.equal(groups.length, 2, '两个项目组');
  assert.deepEqual(groups.map((g) => g.taskCount), [2, 1], '组内计数（含 done，不含归档）');
  const opened: number[] = [];
  const html = renderToStaticMarkup(createElement(ProjectsList, { groups, selectedId: 1, onSelect: (id) => opened.push(id) }));
  assert.match(html, /2 个/);
  assert.match(html, /记账系统/);
  assert.match(html, /2 个任务/);
  assert.match(html, /data-testid="ptree-group"[^>]*data-project-id="1"[^>]*aria-current="page"/, '选中行 aria-current');
  assert.match(html, /官网/);
  assert.equal(html.includes('data-testid="ptree-open-project"'), false, '双栏后不再需要独立入口按钮');
  const empty = renderToStaticMarkup(createElement(ProjectsList, { groups: [], selectedId: null }));
  assert.match(empty, /data-testid="ptree-empty"/, '空态不伪装');
});

test('项目树以 project:list 为准：空项目也显示（真机修复）；归档项目不显示；任务计数同源', () => {
  const projects = [
    { id: 1, name: '记账系统', alias: null, archived: 0 },
    { id: 2, name: '官网', alias: 'web', archived: 0 },
    { id: 3, name: '空项目', alias: null, archived: 0 },
    { id: 4, name: '已归档项目', alias: null, archived: 1 },
  ] as unknown as ProjectDTO[];
  const groups = projectsFromList(projects, TASKS.filter((t) => t.archived !== 1));
  assert.deepEqual(groups.map((g) => g.projectId), [1, 2, 3], '空项目入组；归档项目不入组');
  assert.deepEqual(groups.map((g) => g.taskCount), [2, 1, 0], '任务计数与行数同源');
  assert.equal(groups.find((g) => g.projectId === 3)?.name, '空项目');
  const html = renderToStaticMarkup(createElement(ProjectsList, { groups, selectedId: 3, onSelect: () => {} }));
  assert.match(html, /空项目/);
  assert.match(html, /0 个任务/, '空项目显示 0 个任务，不是消失');
});

test('F-3 F3-12：归档项目进折叠组（不混入活跃组），任务数按全量任务算', () => {
  const projects = [
    { id: 1, name: '记账系统', alias: null, archived: 1 },
    { id: 2, name: '官网', alias: 'web', archived: 0 },
  ] as unknown as ProjectDTO[];
  const archived = archivedProjectsFromList(projects, TASKS);
  assert.deepEqual(archived.map((group) => group.projectId), [1]);
  assert.equal(archived[0]!.taskCount, 3, '含已归档任务的真计数');
  const html = renderToStaticMarkup(
    createElement(ProjectsList, {
      groups: projectsFromList(projects, TASKS),
      archivedGroups: archived,
      selectedId: 1,
      onSelect: () => {},
    }),
  );
  assert.match(html, /data-testid="ptree-archived"/);
  assert.match(html, /已归档（1）/);
  assert.match(html, /data-testid="ptree-archived-group"[^>]*data-project-id="1"/);
});

test('归档页：只列 archived=1；全部/已完成/已取消筛选；空态不伪装', () => {
  const html = renderToStaticMarkup(createElement(ArchiveView, { tasks: TASKS }));
  assert.match(html, /1 个任务/);
  assert.match(html, /data-testid="archive-list"/);
  assert.match(html, /data-task-id="4"/);
  assert.equal(html.includes('data-task-id="1"'), false, '未归档行不进归档页');
  assert.match(html, /data-testid="archive-filter-all"[^>]*aria-pressed="true"/);
  assert.match(html, /data-testid="archive-filter-done"/);
  assert.match(html, /data-testid="archive-filter-cancelled"/);
  assert.match(html, /data-testid="tlist-view"/);
  assert.match(html, /data-testid="tlist-renew"/);
  assert.match(html, /data-testid="tlist-state"[^>]*>已完成/, '归档行状态用「已完成」');

  const empty = renderToStaticMarkup(createElement(ArchiveView, { tasks: TASKS.filter((t) => t.archived !== 1) }));
  assert.match(empty, /data-testid="archive-empty"[^>]*>[\s\S]*?暂无归档任务/);
});

test('归档筛选纯函数：done/cancelled 各取各的；failed 只在全部', () => {
  const rows = [
    task({ id: 11, state: 'done', archived: 1 }),
    task({ id: 12, state: 'cancelled', archived: 1 }),
    task({ id: 13, state: 'failed', archived: 1 }),
    task({ id: 14, state: 'done', archived: 0 }),
  ];
  assert.deepEqual(filterArchivedTasks(rows, 'all').map((t) => t.id), [11, 12, 13]);
  assert.deepEqual(filterArchivedTasks(rows, 'done').map((t) => t.id), [11]);
  assert.deepEqual(filterArchivedTasks(rows, 'cancelled').map((t) => t.id), [12]);
});

test('行组件：点/短号/题/状态/头像；查看/续办文字链；缺 onRenew 时续办 disabled（不假装可点）', () => {
  const html = renderToStaticMarkup(createElement(TaskListItem, { task: TASKS[0]!, onRenew: () => {} }));
  assert.match(html, /data-testid="tlist-dot"/);
  assert.match(html, /T-101/);
  assert.match(html, /演示任务/);
  assert.match(html, /data-testid="tlist-state"[^>]*>执行中/);
  assert.match(html, /data-testid="tlist-avatar"[^>]*>研/);
  assert.match(html, /data-testid="tlist-wait"[^>]*>等待：等槽位（槽位 3\/3）/, 'UG-08：项目树行显示真等待原因');
  assert.doesNotMatch(html.match(/<button[^>]*data-testid="tlist-renew"[^>]*>/)?.[0] ?? '', /disabled/);

  const inert = renderToStaticMarkup(createElement(TaskListItem, { task: TASKS[0]! }));
  assert.match(inert.match(/<button[^>]*data-testid="tlist-renew"[^>]*>/)?.[0] ?? '', /disabled/);
});

test('源码守门：开关语义退役（全仓 0 处）；左栏两导航项＝视图切换；壳路由＋游标白名单', () => {
  const root = 'src';
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') || e.name.endsWith('.tsx') ? [join(dir, e.name)] : [],
    );
  const all = walk(root)
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
  for (const dead of ['showProjects', 'showArchived', 'toggleProjects', 'toggleArchived']) {
    assert.equal(all.includes(dead), false, `开关语义应退役：${dead} 仍出现`);
  }

  const rail = readFileSync('src/renderer/components/LeftRail.tsx', 'utf8');
  assert.ok(rail.includes('showProjectTree') && rail.includes('showArchive'), '左栏两导航项＝切页');
  assert.ok(rail.includes("sessionSnap.view === 'projects'") && rail.includes("sessionSnap.view === 'archive'"), '激活态随视图');

  const shell = readFileSync('src/renderer/AppShell.tsx', 'utf8');
  assert.ok(shell.includes('<ProjectsPage') && shell.includes('<ArchiveView'), '壳路由两页到场');

  const cursor = readFileSync('src/renderer/components/viewCursor.ts', 'utf8');
  assert.ok(cursor.includes("'projects'") && cursor.includes("'archive'"), '游标白名单含两页（重启可恢复）');

  const detail = readFileSync('src/renderer/components/detailReturn.ts', 'utf8');
  assert.ok(detail.includes("case 'projects'") && detail.includes("case 'archive'"), '详情返回随入口含两页');
});
