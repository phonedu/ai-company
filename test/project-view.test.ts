/**
 * 「项目分组 + 项目概览」纯逻辑（含"有牙"）。
 * 口径（3152 裁定 (A′)）：空项目不入；计数同源；不臆造。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  docsHealthView,
  PROJECT_OVERVIEW_UNIMPLEMENTED,
  PROJECT_STATE_LABEL,
  groupProjectTasks,
  projectActionState,
  projectsFromTasks,
} from '../src/renderer/components/projectView.js';
import type { TaskDTO } from '../src/renderer/types.js';

function task(over: Partial<TaskDTO> & { id: number; projectId: number }): TaskDTO {
  return {
    id: over.id,
    shortId: over.shortId ?? `T-${1000 + over.id}`,
    projectId: over.projectId,
    title: over.title ?? `task ${over.id}`,
    state: over.state ?? 'ready',
    priority: over.priority ?? 0,
    riskLevel: over.riskLevel ?? 0,
    createdAt: over.createdAt ?? 1,
    readySince: over.readySince ?? null,
    acceptance: over.acceptance ?? [],
    archived: over.archived ?? 0,
    projectName: over.projectName ?? null,
    projectAlias: over.projectAlias ?? null,
    projectAccessMode: over.projectAccessMode ?? null,
  };
}

test('M2-A 项目分组：按 projectId 归并，空项目不入，按 id 升序', () => {
  const groups = projectsFromTasks([
    task({ id: 1, projectId: 2, projectName: 'Beta', projectAlias: 'b' }),
    task({ id: 2, projectId: 1, projectName: 'Alpha' }),
    task({ id: 3, projectId: 2, projectName: 'Beta', projectAlias: 'b' }),
  ]);
  assert.deepEqual(
    groups.map((g) => g.projectId),
    [1, 2],
    '空项目不入 + 按 projectId 升序',
  );
  assert.equal(groups[1].name, 'Beta');
  assert.equal(groups[1].alias, 'b');
  assert.equal(groups[1].taskCount, 2);
});

test('M2-A 计数同源：组内 taskCount == tasks.length（页面数字必须等于列表行数）', () => {
  const groups = projectsFromTasks([
    task({ id: 1, projectId: 1 }),
    task({ id: 2, projectId: 1 }),
    task({ id: 3, projectId: 3 }),
  ]);
  for (const g of groups) assert.equal(g.taskCount, g.tasks.length, `项目 ${g.projectId} 计数必须同源`);
  assert.equal(
    groups.reduce((n, g) => n + g.taskCount, 0),
    3,
    '各组之和 == 任务总数',
  );
});

test('M2-A 不臆造：缺 projectName → 用 `项目 #<id>` 兜底（不编名字）', () => {
  const groups = projectsFromTasks([task({ id: 1, projectId: 7, projectName: null })]);
  assert.equal(groups[0].name, '项目 #7');
  assert.equal(groups[0].alias, null);
});

test('M2-A 空态：无任务 → 无项目（不造占位组）', () => {
  assert.deepEqual(projectsFromTasks([]), []);
});

test('M2-A 项目内按状态分组：按固定顺序，未知状态排末尾、原样标签', () => {
  const buckets = groupProjectTasks([
    task({ id: 1, projectId: 1, state: 'done' }),
    task({ id: 2, projectId: 1, state: 'executing' }),
    task({ id: 3, projectId: 1, state: 'weird_state' }),
  ]);
  assert.deepEqual(
    buckets.map((b) => b.state),
    ['executing', 'done', 'weird_state'],
    '已知状态按顺序、未知排末尾',
  );
  assert.equal(buckets[0].label, '执行中');
  assert.equal(buckets[2].label, 'weird_state', '未知状态原样，不臆造标签');
});

test('M2-A 状态标签镜像 12 态（防与左栏漂移）', () => {
  assert.equal(Object.keys(PROJECT_STATE_LABEL).length, 12);
  assert.equal('archived' in PROJECT_STATE_LABEL, false, 'archived 已不是 state');
});

test('M2-A＋D-5 ③ "未接入"项 = 一行说明（不摆空壳卡片；归档/恢复已移入本页）', () => {
  assert.match(PROJECT_OVERVIEW_UNIMPLEMENTED, /归档\/恢复项目已就位/);
  assert.doesNotMatch(PROJECT_OVERVIEW_UNIMPLEMENTED, /「恢复项目/, '恢复项目已实现，不再列未实现');
  assert.doesNotMatch(PROJECT_OVERVIEW_UNIMPLEMENTED, /未接入（M2）/, '旧口径已废（归档不再是"未接入"）');
});

test('D-5 ③ 项目操作状态：active/archived 分明；列表未到（null）→ unknown（不摆按钮、不臆造）', () => {
  assert.equal(projectActionState({ archived: 0 }), 'active');
  assert.equal(projectActionState({ archived: 1 }), 'archived');
  assert.equal(projectActionState(null), 'unknown');
  assert.equal(projectActionState(undefined), 'unknown', '列表未到 → 不臆造状态');
  // 有牙：把"归档态"当"活跃"（恒 active 的实现）→ 必须被抓出
  const broken = () => 'active' as const;
  assert.notEqual(broken(), projectActionState({ archived: 1 }), '实现必须真的读 archived 位');
});

test('M2-A "有牙"：若不按 projectId 归并（每任务一组）→ 组数必然变化（证明归并真承重）', () => {
  const tasks = [task({ id: 1, projectId: 1 }), task({ id: 2, projectId: 1 })];
  assert.equal(projectsFromTasks(tasks).length, 1, '归并后 = 1 组');
  const unmerged = tasks.length; // 模拟"每个任务各自成组"
  assert.equal(unmerged, 2);
  assert.notEqual(projectsFromTasks(tasks).length, unmerged, '归并真承重');
});

test('M2 §7 序 4 · docsHealthView：未检查/换项目⇒idle（不沿用别项目结果）、无树显式、失败不静默、截断如实', () => {
  const okResult = {
    docRoot: '.aico/docs',
    hasDocsTree: true,
    truncated: false,
    counts: { live: 7, archive: 2, dangling: 1, oversized: 0, issues: 1 },
    issues: [{ kind: 'ref', path: 'a.md', message: 'a.md: 悬空引用 ./gone.md' }],
  };
  // ① 未检查
  assert.equal(docsHealthView({ status: 'idle', error: null, result: null, resultProjectId: null, selectedProjectId: 1 }).state, 'idle');
  // ② 结果属于别的项目 ⇒ idle（红线：不显上一个项目的读数）
  const stale = docsHealthView({ status: 'idle', error: null, result: okResult, resultProjectId: 9, selectedProjectId: 1 });
  assert.equal(stale.state, 'idle');
  assert.ok(!stale.text.includes('活文档'), '不得沿用别项目的读数');
  // ③ busy / error
  assert.equal(docsHealthView({ status: 'busy', error: null, result: null, resultProjectId: 1, selectedProjectId: 1 }).state, 'busy');
  const err = docsHealthView({ status: 'idle', error: '检查失败：项目不存在：#9', result: null, resultProjectId: 1, selectedProjectId: 1 });
  assert.equal(err.state, 'error');
  assert.ok(err.text.includes('检查失败'), '失败必须显式（不静默）');
  // ④ 无树 ⇒ no-tree（**不显 0**——零悬空会被读成健康）
  const noTree = docsHealthView({
    status: 'idle',
    error: null,
    result: { ...okResult, hasDocsTree: false, counts: { live: 0, archive: 0, dangling: 0, oversized: 0, issues: 0 }, issues: [] },
    resultProjectId: 1,
    selectedProjectId: 1,
  });
  assert.equal(noTree.state, 'no-tree');
  assert.ok(!/活文档 0/.test(noTree.text), '无树不得显 0 读数');
  assert.ok(noTree.text.includes('新建项目时可勾选初始化'), '无树要说明模板入口');
  assert.ok(noTree.text.includes('不做假读数'), '无树不得把 0 当健康');
  assert.equal(noTree.counts, null, '无树不给假计数');
  // ⑤ ok：一行读数＋完整计数/明细；截断如实
  const view = docsHealthView({ status: 'idle', error: null, result: okResult, resultProjectId: 1, selectedProjectId: 1 });
  assert.equal(view.state, 'ok');
  assert.equal(view.text, '活文档 7 · 归档 2 · 悬空 1 · 超线 0');
  assert.equal(view.issues.length, 1);
  assert.equal(view.more, 0);
  assert.deepEqual(view.counts, { live: 7, archive: 2, dangling: 1, oversized: 0, issues: 1 });
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0]?.kindLabel, '引用');
  assert.equal(view.items[0]?.path, 'a.md');
  const many = docsHealthView({
    status: 'idle',
    error: null,
    result: { ...okResult, truncated: true, counts: { ...okResult.counts, issues: 5 }, issues: Array.from({ length: 5 }, (_, i) => ({ kind: 'ref', path: `f${i}.md`, message: `悬空 ${i}` })) },
    resultProjectId: 1,
    selectedProjectId: 1,
  });
  assert.equal(many.issues.length, 3, '兼容旧一行读数：摘要最多 3 条');
  assert.equal(many.items.length, 5, '面板展示完整明细');
  assert.equal(many.more, 0, '5 条全部展示，无“更多”');
  assert.ok(many.text.includes('已截断'), '截断如实标注');
});

test('M3-DOC-2：项目概览渲染完整面板（计数/明细/清空/截断），不是只贴一行', () => {
  const source = readFileSync('src/renderer/components/ProjectOverview.tsx', 'utf8');
  for (const id of [
    'docs-health-panel',
    'docs-health-counts',
    'docs-health-count-live',
    'docs-health-count-archive',
    'docs-health-count-dangling',
    'docs-health-count-oversized',
    'docs-health-count-issues',
    'docs-health-clean',
    'docs-health-more',
    'docs-health-truncated',
  ]) {
    assert.ok(source.includes(`data-testid="${id}"`), `缺 ${id}`);
  }
  assert.ok(source.includes('docsView.items.map'), '明细未逐条渲染');
});

test('UI 简化：项目设置折叠，任务树排前（配置卡不再铺满概览）', () => {
  const source = readFileSync('src/renderer/components/ProjectOverview.tsx', 'utf8');
  assert.match(source, /data-testid="project-settings"/);
  //  外层摘要不再枚举 6 项（分组导航接管），这里锁「折叠块仍在 + 分组导航在场」。
  assert.match(source, /project-settings__groupnav/);
  assert.match(source, /data-testid="project-settings-groupnav"/);
  assert.match(source, /project-tasks-card/);
  const css = readFileSync('src/renderer/styles.css', 'utf8');
  assert.match(css, /\.project-settings\s*\{[^}]*order:\s*2/s);
  assert.match(css, /\.project-settings__body\s*\{[^}]*gap:\s*20px/s, '项目设置卡片必须留 20px 间距，不能挤在一起');
  assert.match(css, /\.project-tasks-card\s*\{[^}]*order:\s*1/s);
});
