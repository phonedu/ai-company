/**
 * OPT-M6-1「差异台账轻产品化」：**复用 `task_events`**（`kind='deviation_recorded'`），**不新建表/不加迁移**。
 * 口径：偏离/绕法必须带 **owner + 里程碑**；**收尾不得有\"未结且无 owner\"的项**（\"偏离清零\"读数）。
 */
export const DEVIATION_KIND = 'deviation_recorded';

export interface DeviationPayloadLike {
  title?: unknown;
  why?: unknown;
  owner?: unknown;
  milestone?: unknown;
  status?: unknown;
}

export interface DeviationProblems {
  missingOwner: boolean;
  missingMilestone: boolean;
}

/** 校验一条偏离 payload：**owner 与里程碑必填**（缺则不许入库/收尾不得通过）。 */
export function validateDeviation(payload: unknown): DeviationProblems {
  const p = (payload ?? {}) as Record<string, unknown>;
  const owner = p.owner;
  return {
    missingOwner: owner == null || owner === '' || (typeof owner === 'number' && Number.isNaN(owner)),
    missingMilestone: typeof p.milestone !== 'string' || p.milestone.trim().length === 0,
  };
}

export interface DeviationItem {
  title: string;
  why: string | null;
  owner: string | null;
  milestone: string | null;
  status: string;
  open: boolean;
}

export interface DeviationSummary {
  total: number;
  open: number;
  /** 未结（`status!=='resolved'`）且**无 owner** 的项标题 —— 收尾读数，必须为空。 */
  openWithoutOwner: string[];
  /** UG-07：逐条明细（只读投影；旧调用方可忽略）。 */
  items?: DeviationItem[];
}

/** 从任务 `timeline`（`task_events`）派生偏离读数（**只读**，零 schema）。 */
export function summarizeDeviations(
  timeline: Array<{ kind: string; payload: unknown }>,
): DeviationSummary {
  const deviations = timeline.filter((e) => e.kind === DEVIATION_KIND);
  const openWithoutOwner: string[] = [];
  const items: DeviationItem[] = [];
  let open = 0;
  for (const e of deviations) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const isOpen = p.status !== 'resolved';
    const title = typeof p.title === 'string' && p.title.length > 0 ? p.title : '(未命名偏离)';
    if (isOpen) {
      open += 1;
      if (validateDeviation(p).missingOwner) openWithoutOwner.push(title);
    }
    items.push({
      title,
      why: typeof p.why === 'string' && p.why.trim().length > 0 ? p.why.trim() : null,
      owner:
        typeof p.owner === 'string' && p.owner.trim().length > 0
          ? p.owner.trim()
          : typeof p.owner === 'number'
            ? String(p.owner)
            : null,
      milestone: typeof p.milestone === 'string' && p.milestone.trim().length > 0 ? p.milestone.trim() : null,
      status: typeof p.status === 'string' && p.status.length > 0 ? p.status : 'open',
      open: isOpen,
    });
  }
  return { total: deviations.length, open, openWithoutOwner, items };
}

/** 收尾门：**存在\"未结且无 owner\"的偏离 → 不得收尾**（`openWithoutOwner` 非空即红）。 */
export function hasUnclosedUnmanaged(summary: DeviationSummary): boolean {
  return summary.openWithoutOwner.length > 0;
}
