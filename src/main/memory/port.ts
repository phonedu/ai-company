/**
 * 记忆模块 v1 —— `MemoryPort`（唯一入口）。
 *
 * **复用边界**：调用方只依赖本接口；SQLite 只是适配器（`SqliteMemoryStore`）。
 * v1 同进程同步（Electron + better-sqlite3）；后期抽包/进程时加异步适配器，
 * 核心 policy/brief/audit 不依赖存储细节。
 */
import type {
  BriefInput,
  Confirmation,
  MemoryAudit,
  MemoryBrief,
  MemoryHit,
  MemoryItem,
  MemoryPatch,
  MemoryQuery,
  MemoryScope,
  RememberInput,
  SourceRef,
} from './types.js';

export type {
  BriefInput,
  Confirmation,
  MemoryAudit,
  MemoryBrief,
  MemoryHit,
  MemoryItem,
  MemoryPatch,
  MemoryQuery,
  MemoryScope,
  RememberInput,
  SourceRef,
};

export interface MemoryPort {
  /** 写入/合并/取代；同 key 同值幂等。 */
  remember(input: RememberInput): MemoryItem;
  update(id: number, patch: MemoryPatch, source: SourceRef): MemoryItem;
  forget(id: number, mode: 'archive' | 'delete'): void;
  get(id: number): MemoryItem | null;
  list(query: MemoryQuery): MemoryItem[];
  search(query: MemoryQuery): MemoryHit[];
  /** 按 principal/预算组装注入段；不返回空段。 */
  brief(input: BriefInput): MemoryBrief;
  audit(scope?: MemoryScope): MemoryAudit;
  /** 项目事实 → 全局事实（或反向）需老板显式确认。 */
  promote(id: number, to: MemoryScope, confirmation: Confirmation): MemoryItem;
}
