/**
 * 记忆模块 v1 —— 公共类型（**不依赖 Electron / Pi / 渲染层**）。
 *
 * 口径：docs/work/design-memory-v1.md（D-17）。
 * 分层：L1 任务摘要仍在 `employee_memory`（自动、确定性）；
 *       `memory_items` 承载 L2 项目事实 / L3 全局事实；`memory_events` 承载审计。
 */
export type MemoryScope = { type: 'global' } | { type: 'project'; projectId: number };

export type Principal =
  | { kind: 'assistant' }
  | { kind: 'employee'; employeeId: number }
  | { kind: 'critic' }
  | { kind: 'verifier' };

export type SourceType = 'boss' | 'assistant' | 'employee' | 'task' | 'doc' | 'artifact';

export interface SourceRef {
  type: SourceType;
  /** task id / message id / artifact id / doc path；可空（无来源不得写 confirmed）。 */
  ref?: string | null;
  /** 短摘录；不得存密钥/长文。 */
  excerpt?: string | null;
  at?: number;
}

export type MemoryKind = 'fact' | 'decision' | 'preference' | 'glossary' | 'constraint';
export type Confidence = 'confirmed' | 'provisional' | 'inferred';
export type MemoryStatus = 'active' | 'superseded' | 'archived';

export interface MemoryItem {
  id: number;
  scope: MemoryScope;
  kind: MemoryKind;
  key: string | null;
  value: string;
  source: SourceRef;
  confidence: Confidence;
  status: MemoryStatus;
  pinned: boolean;
  validFrom: number | null;
  validTo: number | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  lastVerifiedAt: number | null;
  supersededBy: number | null;
}

export interface RememberInput {
  scope: MemoryScope;
  kind: MemoryKind;
  key?: string | null;
  value: string;
  source: SourceRef;
  confidence?: Confidence;
  pinned?: boolean;
  validFrom?: number | null;
  validTo?: number | null;
  expiresAt?: number | null;
  /** 测试/重放用；缺省 Date.now()。 */
  now?: number;
}

export interface MemoryPatch {
  value?: string;
  key?: string | null;
  confidence?: Confidence;
  pinned?: boolean;
  validTo?: number | null;
  expiresAt?: number | null;
  lastVerifiedAt?: number | null;
}

export interface MemoryQuery {
  scope?: MemoryScope;
  principal?: Principal;
  text?: string;
  kind?: MemoryKind;
  includeHistorical?: boolean;
  includeArchived?: boolean;
  limit?: number;
}

export interface MemoryHit {
  item: MemoryItem;
  score: number;
  snippet: string;
}

export interface BriefInput {
  principal: Principal;
  projectId?: number | null;
  taskId?: number | null;
  text?: string;
  /** 覆盖默认 2000；用于测试/实验。 */
  budgetTokens?: number;
  /** 现有 L1 摘要（可选）；模块只做预算裁剪，不直接读 employee_memory。 */
  taskMemory?: string;
}

export interface MemoryBriefSection {
  name: 'global' | 'project' | 'task' | 'retrieval';
  items: MemoryItem[];
  text: string;
  tokens: number;
  dropped: MemoryItem[];
}

export interface MemoryBrief {
  sections: MemoryBriefSection[];
  totalTokens: number;
  truncated: boolean;
}

export interface MemoryAudit {
  scope: MemoryScope | null;
  total: number;
  active: number;
  duplicates: MemoryItem[];
  conflicts: MemoryItem[];
  stale: MemoryItem[];
  oversize: MemoryItem[];
  missingSource: MemoryItem[];
  tokens: number;
}

export interface Confirmation {
  by: 'boss';
  confirmed: boolean;
  at?: number;
}

/** 同 key 两条同权威事实冲突（不静默覆盖；由调用方出决策卡）。 */
export class MemoryConflictError extends Error {
  readonly name = 'MemoryConflictError';
  constructor(
    message: string,
    readonly existing: MemoryItem,
    readonly incoming: RememberInput,
  ) {
    super(message);
  }
}
