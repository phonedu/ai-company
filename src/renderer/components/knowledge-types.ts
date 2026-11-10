/**
 * K1 知识库 · 列表条目类型与键（2026-10-28 从 KnowledgePage 抽出）。
 *
 * （真机批）：键曾为 `projectId-name`，同项目同名条目（周报助手两份 README：
 * `.aico/docs/README.md` 文档＋根目录产物）撞键 → React 按键对账行为未定义 → 旧 DOM 残留
 * （搜索过滤后幻影卡片常驻、甚至与「没有匹配的内容」空态并存；真机 CDP fiber 对质实锤，
 * 幻影节点 index=全量数组末位）。键改含 type＋path——文件全路径在扫描面内唯一。
 */

export interface NoteItem {
  name: string;
  type: 'note' | 'doc' | 'artifact' | 'media' | 'text' | 'file';
  path: string;
  /** 媒体/附件扩展名与大小（Phase A 扫描补充；md 可能缺省）。 */
  ext?: string;
  size?: number;
  lines: number;
  updatedAt: number;
  preview: string;
  projectName: string | null;
  projectId: number | null;
}

export function knowledgeItemKey(item: NoteItem): string {
  return `${item.projectId ?? 'g'}-${item.type}-${item.path}`;
}

/**
 * （真机批登记，2026-10-28 裁 A）：「＋新建笔记」落点跟随当前范围——
 * 与 （助手 note_write 落点）同语义：范围内落该项目 `.aico/notes/`，范围＝公司落全局；
 * 提示文案随落点如实变化（不臆造落点）。
 */
export function newNoteTarget(scopeProjectId: number | null): {
  projectId: number | null;
  hint: string;
} {
  if (scopeProjectId != null && scopeProjectId > 0) {
    return { projectId: scopeProjectId, hint: '将存入当前范围项目的笔记（.aico/notes/）；切到「公司」范围则存全局。' };
  }
  return { projectId: null, hint: '将存入全局笔记库（当前范围＝公司）；想存进某个项目，先把范围切到该项目。' };
}
