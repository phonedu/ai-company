// ─────────────────────────────────────────────────────────────────────────────
// 任务详情「返回」（纯逻辑，2026-10-16 任务详情批）——**返回随入口动态**：
//   从哪个视图进的详情，返回就回哪儿（缺省＝老板频道）。文案与判据抽出来可 node 测；
//   真正的跳转在 `store.leaveTaskDetail`（要引 store，测试编不动）。
// ─────────────────────────────────────────────────────────────────────────────

export type DetailOrigin = 'channel' | 'task' | 'hall' | 'inbox' | 'project' | 'employee' | 'settings' | 'projects' | 'archive' | 'notes' | null | undefined;

export interface DetailReturnInfo {
  /** 返回钮文案（`← X`）。 */
  label: string;
  /** 返回目标视图（`task` 视作未知 → 频道）。 */
  target: Exclude<DetailOrigin, null | undefined | 'task'>;
}

/** 入口视图 → 返回文案/目标（未知/详情自身 ⇒ 老板频道——不臆造）。 */
export function detailReturn(origin: DetailOrigin): DetailReturnInfo {
  switch (origin) {
    case 'inbox':
      return { label: '待我处理', target: 'inbox' };
    case 'hall':
      return { label: '公司大厅', target: 'hall' };
    case 'project':
      // 兼容旧入口记录：项目概览已并入「项目树」页右栏（2026-10-17 双栏改版）。
      return { label: '项目树', target: 'projects' };
    case 'employee':
      return { label: '员工设置', target: 'employee' };
    case 'settings':
      return { label: '设置', target: 'settings' };
    case 'projects':
      return { label: '项目树', target: 'projects' };
    case 'archive':
      return { label: '归档', target: 'archive' };
    default:
      return { label: '老板频道', target: 'channel' };
  }
}
