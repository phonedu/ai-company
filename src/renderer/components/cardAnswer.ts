/**
 * 多选＋自定义作答卡（老板 2026-10-28 指令）· 判定与作答串（纯函数，零依赖可单测）。
 *
 * - `selection='multi'`：选项可勾选、统一「提交」作答；chosen＝勾选键 `k1+k2`（＋连接，见 multiChosen）。
 * - 自定义作答：决策/普通 ask 卡且带选项列表时给文本入口（chosen＝原文）；
 *   批准卡（approve/revise）与权限卡（approve_once/…）的键绑定机器事件——**不给**自定义。
 */

/** 卡 payload.selection === 'multi' 才多选；缺省/未知值不猜＝单选。 */
export function isMultiSelect(payload: { selection?: unknown }): boolean {
  return payload.selection === 'multi';
}

/** 多选提交的作答串：勾选键按 `+` 连接（消费侧 split('+') 还原）。 */
export function multiChosen(keys: string[]): string {
  return keys.join('+');
}

/** 自定义作答入口是否显示：ask 卡、有选项列表、且选项非机器键（approval/permission）。 */
export function customAnswerAllowed(card: {
  kind: string;
  payload: { card?: unknown; options?: unknown };
}): boolean {
  if (card.kind !== 'ask') return false;
  if (!Array.isArray(card.payload.options) || card.payload.options.length === 0) return false;
  return card.payload.card !== 'approval' && card.payload.card !== 'permission';
}

export interface PermissionDetail {
  who: string;
  action: string;
  project: string;
  session?: string | null;
}

/**
 * 权限卡结构化读法（卡片可读性批，老板 2026-10-28）：gate 组卡附 permissionDetail
 * （who/action/project/session）——渲染层优先三行人话（「谁、想干什么、在哪个项目」），
 * session/原始串收进折叠；老卡（无 detail 或坏数据）→ null 回落 question 原串。
 */
export function permissionDetailLines(payload: { permissionDetail?: unknown }): PermissionDetail | null {
  const d = payload.permissionDetail as Partial<PermissionDetail> | undefined;
  if (d == null || typeof d !== 'object') return null;
  if (typeof d.who !== 'string' || d.who.trim().length === 0) return null;
  if (typeof d.action !== 'string' || d.action.trim().length === 0) return null;
  if (typeof d.project !== 'string' || d.project.trim().length === 0) return null;
  return {
    who: d.who.trim(),
    action: d.action.trim(),
    project: d.project.trim(),
    session: typeof d.session === 'string' && d.session.length > 0 ? d.session : null,
  };
}
