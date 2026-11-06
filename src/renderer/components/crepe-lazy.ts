/**
 * Crepe 懒加载门面（G-3 回归锚点）。
 *
 * ① MilkdownEditor 不直接 `await import('@milkdown/crepe')`：经这个纯静态 re-export 门面，
 *    Rollup 为 crepe 生成独立懒 chunk，`Crepe`/`replaceAll` 成为 chunk 级具名导出（保持懒加载、不进首屏包）。
 * ② `replaceAll` 来自 @milkdown/kit/utils：Crepe 7.x **没有 setMarkdown**（K1 初版误用，
 *    真窗口里 TypeError → 静默回落 textarea，编辑器从未真正工作）。设内容唯一口径：
 *    `crepe.editor.action(replaceAll(md))`。
 */
// 2026-11-05：本文件被 Node 侧测试链间接引入（test → TaskDetail → PreviewDrawer → 只读预览）后，
// 主编译 tsconfig（moduleResolution: NodeNext）会因 @milkdown 的类型声明是无扩展名 re-export（Bundler 风格）
// 报 TS2305「没有导出成员」——是**解析差异，不是真缺导出**：web 构建（Bundler）类型校验通过、运行由 Vite 解析。
// 这两行仅对 NodeNext 静默；类型面仍由 `tsc -p tsconfig.web.json` 把关。
// @ts-ignore -- NodeNext 解析 @milkdown/crepe 类型失败（Bundler 下正常）
export { Crepe } from '@milkdown/crepe';
// @ts-ignore -- NodeNext 解析 @milkdown/kit/utils 类型失败（Bundler 下正常）
export { replaceAll } from '@milkdown/kit/utils';

// RW-17（M5 真机 S9 批）：Crepe 主题 CSS 从未装载——列表圆点与文字错位、表格无框线全是裸奔渲染。
// 注意：frame-dark.css／style.css 这类聚合文件靠 @import 拼装，Vite 依赖预构建不内联它们＝
// 构建产物只剩一条死 @import（真机验证过）；必须按叶子直引（本文件已核对叶子内无二级 @import）。
import '@milkdown/crepe/theme/common/reset.css';
import '@milkdown/crepe/theme/common/list-item.css';
import '@milkdown/crepe/theme/common/table.css';
import '@milkdown/crepe/theme/common/placeholder.css';
import '@milkdown/crepe/theme/common/block-edit.css';
import '@milkdown/crepe/theme/common/cursor.css';
import '@milkdown/crepe/theme/common/link-tooltip.css';
import '@milkdown/crepe/theme/common/toolbar.css';

// RW-29（S13-A，老板真机：块菜单文字变白/大面积重合）：common 叶子只写结构，颜色/阴影
// 全走 --crepe-color-* 变量，变量真源在 frame / frame-dark 主题里——此前未引 → 浅色下白字叠影。
// 本文件按应用主题成对声明变量（数值照抄上游，字号对齐 15px），与上面叶子一起进懒块。
import '../assets/crepe-theme.css';
