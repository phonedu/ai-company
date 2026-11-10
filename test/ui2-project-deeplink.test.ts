/**
 *   收尾：深链改道。
 *
 * 口径：频道卡 / 待办行 / 命令面板点任务 ⇒ **项目页并展开对应行**；整页详情
 * （`view='task'`）只保留为逃生口（行内详情 ↗ / diff / 原始交流 / 归档页）。
 * 手法：renderer 组件依赖 store（web 图），node 测试直接 import 会把浏览器侧模块
 * 拉进来；沿用本仓既有「纯函数 + 源码守门」手法（见 card-ui.test.ts）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const storeSrc = readFileSync('src/renderer/store.ts', 'utf8');
const overviewSrc = readFileSync('src/renderer/components/ProjectOverview.tsx', 'utf8');
const cardSrc = readFileSync('src/renderer/components/Card.tsx', 'utf8');
const inboxSrc = readFileSync('src/renderer/components/InboxView.tsx', 'utf8');
const shellSrc = readFileSync('src/renderer/AppShell.tsx', 'utf8');

function functionBody(src: string, marker: string): string {
  const start = src.indexOf(marker);
  assert.notEqual(start, -1, `找不到 ${marker}`);
  const rest = src.slice(start + marker.length);
  // 取到下一个顶层 `export` 或文件尾（函数体内不会出现列首 export）。
  const end = rest.search(/\nexport (?:async )?(?:function|const|class) /);
  return end === -1 ? rest : rest.slice(0, end);
}

test('store：openTaskFromLink 走项目页＋待展开，查不到任务才回落整页详情', () => {
  const body = functionBody(storeSrc, 'export async function openTaskFromLink(taskId: number): Promise<void> {');
  assert.match(body, /session\.view = 'projects'/, '深链必须落到项目页');
  assert.match(body, /session\.selectedProjectId = task\.projectId/, '选中任务所属项目');
  assert.match(body, /projectPage\.pendingTaskId = taskId/, '把待展开任务交给项目页消费');
  assert.match(body, /await loadTasks\(\{ includeArchived: true \}\)/, '任务列表未命中时补拉一次真值');
  assert.match(body, /await openTaskDetail\(taskId\)/, '真值缺失才回落整页逃生口（不静默）');
  assert.match(
    storeSrc,
    /pendingTaskId: null as number \| null/,
    'projectPage 必须持有深链待展开槽（一次性消费）',
  );
});

test('项目页：消费 pendingTaskId ⇒ 切任务页签、清搜索词、展开并聚焦目标行', () => {
  assert.match(overviewSrc, /const pendingTaskId = projectPageSnap\.pendingTaskId/, '读取深链槽');
  assert.match(overviewSrc, /setTab\('tasks'\)/, '深链目标是任务页签');
  assert.match(overviewSrc, /setTaskQuery\(''\)/, '搜索词不能把目标行过滤掉');
  assert.match(overviewSrc, /void expandTaskRow\(pendingTaskId\)/, '深链要展开对应行');
  assert.match(overviewSrc, /scrollIntoView\(\{ block: 'center' \}\)/, '目标行要滚到可见');
  assert.match(overviewSrc, /projectPage\.pendingTaskId = null/, '消费一次即清（不重复展开）');
  assert.match(
    overviewSrc,
    /data-testid="project-task-row"\s*\n?\s*data-task-id=\{task\.id\}/,
    '行按钮带 data-task-id（聚焦/真机断言锚点）',
  );
});

test('行下展开：Esc 收起后焦点回到原行（再点同行的另一条路径由行按钮自身处理）', () => {
  assert.match(overviewSrc, /lastExpandedTaskRef/, '记住上一次展开行，供收起后回焦');
  assert.match(overviewSrc, /\.focus\(\)/, '收起后把焦点还给行按钮');
});

test('频道卡片：任务入口改走项目页深链，产物预览仍走整页（抽屉依赖详情页挂载）', () => {
  assert.match(cardSrc, /openTaskFromLink/, '卡片任务入口必须用深链');
  assert.doesNotMatch(
    cardSrc,
    /void openTaskDetail\(card\.taskId as number\);/,
    '任务入口不得再直接跳整页（逃生口在行内 ↗）',
  );
  assert.match(cardSrc, /void openTaskDetail\(card\.taskId\);\s*\n\s*void readArtifact\(artifactId\);/, '产物预览保持整页路径');
});

test('待办页：短号/任务详情/去验收三个入口都走项目页深链', () => {
  assert.match(inboxSrc, /openTaskFromLink/, '待办入口必须用深链');
  assert.doesNotMatch(inboxSrc, /void openTaskDetail\(card\.taskId as number\)/, '待办不再跳整页详情');
});

test('命令面板：任务命中走项目页深链（产物命中保留整页＋抽屉）', () => {
  assert.match(shellSrc, /if \(item\.kind === 'task'\) void openTaskFromLink\(item\.id\)/, '任务命中改深链');
  assert.match(shellSrc, /void openTaskDetail\(taskId\)\.then\(\(\) => readArtifact/, '产物命中保持整页＋抽屉');
});
