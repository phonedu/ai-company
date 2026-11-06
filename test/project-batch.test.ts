/**
 * 项目概览批（2026-10-17，替换批·第八批）——判据（源码/样式级；本组件引 store、node 编不动，
 * 组件的纯逻辑件〔`projectView.ts`〕由 `project-view.test.ts` 覆盖）：
 *   ① 层级纪律：**左栏直达二级页无返回**——「返回老板频道」已删、样式退役；
 *   ② 多项目切换：项目名 ▾ → 弹层（名/别名＋**任务数真计数**＋已归档标；当前项 aria-current；
 *      Esc 关闭；选中即 `showProject`）；
 *   ③ 任务行〔打开 ▸〕→ `openTaskDetail`；**已取消组默认收起**（`<details>` 无 open）；
 *   ④ rootDir 真值显示；〔打开目录〕已接线（2026-10-25 dogfood L-01：onClick → openProjectDir，路径主进程解析）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync('src/renderer/components/ProjectOverview.tsx', 'utf8');
const page = readFileSync('src/renderer/components/ProjectsPage.tsx', 'utf8');
const list = readFileSync('src/renderer/components/TaskListViews.tsx', 'utf8');
const css = readFileSync('src/renderer/styles.css', 'utf8');

test('层级纪律：概览无返回钮（「返回老板频道」已删；样式退役）', () => {
  assert.equal(src.includes('返回老板频道'), false, '左栏直达二级页不得有返回钮');
  assert.equal(src.includes('project-back'), false, 'project-back 应已删除');
  assert.equal(css.includes('.project-view__back'), false, '退役样式不得残留');
});

test('双栏改版（2026-10-17）：项目切换＝左列项目列表（不跳页）；概览不再有 ▾ 弹层', () => {
  // 左列：项目行（名/别名/任务数）＋选中 aria-current；点＝showProject（页面不跳）。
  assert.ok(list.includes('data-testid="ptree-group"'), '缺项目行');
  assert.ok(page.includes('showProject(projectId)'), '点项目＝右栏切换');
  assert.equal(page.includes('showProject(p.id)'), false, '旧弹层条目已撤');
  assert.ok(list.includes("aria-current={selectedId === group.projectId ? 'page' : undefined}"), '缺选中态');
  // 概览右栏：不再有切换钮/弹层。
  assert.equal(src.includes('data-testid="project-switch"'), false, '概览右栏不应再有 ▾ 切换钮');
  assert.equal(src.includes('data-testid="project-picker"'), false, '概览右栏不应再有弹层');
  // 选中失效/初次进入自动选第一个（右栏不空）。
  assert.ok(page.includes('showProject(firstId)'), '缺自动补选');
});

test('任务行〔打开 ▸〕→ 详情；已取消组默认收起（details 无 open）', () => {
  assert.ok(src.includes('data-testid="project-task-open"'), '缺〔打开 ▸〕');
  assert.ok(src.includes('openTaskDetail(task.id)'), '打开须进任务详情');
  assert.ok(src.includes("bucket.state === 'cancelled'"), '已取消组判定在场');
  assert.ok(src.includes('<details>'), '收起用 details');
  assert.equal(/<details\s+open/.test(src), false, '已取消组默认**不展开**');
});

test('路径与入口：rootDir 真值；〔打开目录〕已接线（L-01）', () => {
  assert.ok(src.includes('data-testid="project-rootdir"'), '缺 rootDir 读数');
  assert.ok(src.includes('data-testid="project-open-dir"'), '缺〔打开目录〕');
  assert.match(src, /data-testid="project-open-dir"/, '缺按钮');
  assert.equal(/data-testid="project-open-dir"[^>]*disabled/.test(src), false, '已接线不得再 disabled');
  assert.ok(src.includes('openProjectDir(project.id)'), '按钮须调 store 的 openProjectDir');
  assert.ok(src.includes('在系统文件管理器中打开项目根目录'), '按钮须有可读 title');
  assert.equal(src.includes('未接线（打开目录随后续件）'), false, '旧未接线理由应撤');
});

test('样式守门：双栏页/概览卡/任务行 规则在场', () => {
  const rule = (sel: string): string => {
    const at = css.indexOf(`\n${sel} {`);
    assert.ok(at >= 0, `缺规则 ${sel}`);
    return css.slice(at, css.indexOf('}', at));
  };
  assert.ok(rule('.projects-page__item').length > 0, '缺左列项目行样式');
  // 双栏容器是合并选择器（.projects-page__list, .hall-page__list）——直接断言整段。
  assert.ok(/\.projects-page__list,[\s\S]*?border-right/.test(css), '左列与右栏以发丝分隔');
  assert.ok(css.includes('.hall-page__list'), '缺大厅左列样式');
  assert.ok(rule('.project-pane__card').length > 0, '缺概览卡样式');
  assert.ok(rule('.project-view__task-open').length > 0, '缺任务行打开样式');
  assert.ok(rule('.project-view__state-title').length > 0, '缺分组题样式');
  assert.ok(rule('.project-view__task-archive').length > 0, '缺任务行归档样式');
});
