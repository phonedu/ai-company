/**
 * OPT-M4-1 · 接缝边界（boundary）**单一真源**（`PLAN §10` 第二批 / `docs/work/ledger-opt-total.md` OPT-M4-1）。
 *
 * 「接缝矩阵」= **边界 × 覆盖**：每个 `boundary` 必须有一格，标明覆盖它的 `test`/`accept`；
 * **空格（未覆盖）必须登记 owner + 里程碑**（缺项即门禁红）。`schema.sql` 的 `seams.boundary` 只存文本，
 * 枚举真源在代码（本文件）→ 建议在 `DEV` 同步一行指针。
 */
export const SEAM_BOUNDARIES = [
  'ui-engine',
  'preload-main',
  'db-migrations',
  'engine-toolproc',
  'dev-packaged',
  'product-im',
] as const;

export type SeamBoundary = (typeof SEAM_BOUNDARIES)[number];

/** 人类可读标签（与需求文档的 `UI↔引擎` 等对应）。 */
export const SEAM_BOUNDARY_LABELS: Record<SeamBoundary, string> = {
  'ui-engine': 'UI ↔ 引擎',
  'preload-main': 'preload ↔ main',
  'db-migrations': 'DB ↔ migrations',
  'engine-toolproc': '引擎 ↔ 工具子进程',
  'dev-packaged': 'dev ↔ packaged',
  'product-im': '产品 ↔ IM 通道',
};

export function isSeamBoundary(value: string): value is SeamBoundary {
  return (SEAM_BOUNDARIES as readonly string[]).includes(value);
}

export type SeamStatus = 'covered' | 'gap';

export interface SeamMatrixCell {
  boundary: string;
  status: SeamStatus;
  /** 覆盖它的 test / accept（`status='covered'` 时必填）。 */
  coverageRef?: string | null;
  /** 未覆盖时的责任人（`status='gap'` 时必填）。 */
  owner?: string | null;
  /** 未覆盖时的归口里程碑（`status='gap'` 时必填）。 */
  milestone?: string | null;
}

export interface SeamMatrixIssue {
  boundary: string;
  problem: string;
}

/**
 * 门禁：核对矩阵是否**完整且每格有归属**。
 * 返回问题列表（空 = 通过）；**任一问题 → 门禁红**。
 */
export function checkSeamMatrix(cells: SeamMatrixCell[]): SeamMatrixIssue[] {
  const issues: SeamMatrixIssue[] = [];
  const byBoundary = new Map(cells.map((c) => [c.boundary, c]));

  for (const boundary of SEAM_BOUNDARIES) {
    const cell = byBoundary.get(boundary);
    if (!cell) {
      issues.push({ boundary, problem: '矩阵缺此边界（未登记）' });
      continue;
    }
    if (cell.status === 'covered') {
      if (!cell.coverageRef || cell.coverageRef.trim() === '') {
        issues.push({ boundary, problem: "status='covered' 但缺 coverage_ref" });
      }
    } else if (cell.status === 'gap') {
      if (!cell.owner || cell.owner.trim() === '') issues.push({ boundary, problem: "空格（gap）缺 owner" });
      if (!cell.milestone || cell.milestone.trim() === '') issues.push({ boundary, problem: '空格（gap）缺 milestone' });
    } else {
      issues.push({ boundary, problem: `未知 status：${String((cell as { status: unknown }).status)}` });
    }
  }
  for (const cell of cells) {
    if (!isSeamBoundary(cell.boundary)) issues.push({ boundary: cell.boundary, problem: '枚举外的边界（文档没有的第三套？）' });
  }
  return issues;
}
