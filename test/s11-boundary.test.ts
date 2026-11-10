/**
 *  边界批（2026-10-28 真机）：窄窗 ≤1040px（G-9）两个真缺陷的回归守卫。
 *
 * ① 项目树/大厅左列固定 300px：窄窗下右栏只剩 ~200px，任务标题被行内按钮挤到不可见
 *    （真机 719px：T-1019 只露「在」）→ 必须有 ≤1040px 上下堆叠的媒体查询；
 * ② 行内「归档／打开」按钮文字被压成竖排两行 → 按钮不收缩、文字不换行。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync('src/renderer/styles.css', 'utf8');

test('S11① 窄窗堆叠迁 SplitLayout（2026-11-04）：34vh 截断退役，堆叠由 data-stacked 驱动', () => {
  // 旧媒体查询实现已退役：不得再有 34vh 截断；堆叠真源＝SplitLayout 组件（断点单源）。
  assert.doesNotMatch(css, /max-height:\s*34vh/, '34vh 拦腰截断必须退役');
  const split = readFileSync('src/renderer/components/SplitLayout.tsx', 'utf8');
  assert.match(split, /data-stacked/, 'SplitLayout 必须输出堆叠标记');
  assert.match(split, /NARROW_QUERY = '\(max-width: 1040px\)'/, '断点真源在 SplitLayout（单处定义）');
  // 项目树/大厅已接入：渲染树里有 split-projects / split-hall 容器
  const projects = readFileSync('src/renderer/components/ProjectsPage.tsx', 'utf8');
  const hall = readFileSync('src/renderer/components/CompanyHallView.tsx', 'utf8');
  assert.match(projects, /storageKey="projects"/, '项目树已接 SplitLayout');
  assert.match(hall, /storageKey="hall"/, '大厅已接 SplitLayout');
  // stacked 模式下宽窗专属边框交给容器
  assert.match(css, /\.split__drawer \.hall-page__list/, '大厅侧栏抽屉内去右缘边框');
});

test('S11② 行内按钮不收缩不换行（归档／打开不再竖排）', () => {
  assert.match(
    css,
    /\.project-view__task-open,\s*\n\.project-view__task-archive\s*\{[^}]*flex:\s*0 0 auto[^}]*white-space:\s*nowrap/,
    '两个行内按钮必须 nowrap 且不收缩',
  );
});
