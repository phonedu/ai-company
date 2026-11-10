/** 文档检查验收项的**唯一命令标识**（写入标准真源）。 */
export const DOCS_CHECK_COMMAND = 'aico:docs-check';

/** 该验收项是否是机器文档检查（规划/员工上下文不把它当“要干的一步”）。 */
export function isDocsCheckAcceptance(item: unknown): boolean {
  return item != null && typeof item === 'object' && (item as { check?: unknown }).check === DOCS_CHECK_COMMAND;
}
