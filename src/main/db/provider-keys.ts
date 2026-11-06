/**
 * `provider_keys` 台账（schema §供应商凭据池）：只记「供应商 / 标签 / 指向 secrets 的条目名」，
 * **绝不存明文**。v1 每个供应商一条「主」Key（UNIQUE(provider,label)）；删除＝删行（文件由凭据面清）。
 *
 * 读者：设置页「模型与供应商」的状态/保存/清除（`ipc.ts` 的 `provider:*`）。运行时仍从文件/env 读。
 */
import type { SqliteDb } from './open.js';

export interface ProviderKeyRow {
  id: number;
  provider: string;
  label: string;
  secretRef: string;
  enabled: number;
  createdAt: number;
}

export interface UpsertProviderKeyInput {
  provider: string;
  label?: string;
  secretRef: string;
  now: number;
}

export function listProviderKeys(db: SqliteDb): ProviderKeyRow[] {
  return db
    .prepare('SELECT id, provider, label, secret_ref AS secretRef, enabled, created_at AS createdAt FROM provider_keys ORDER BY provider, label')
    .all() as ProviderKeyRow[];
}

export function upsertProviderKey(db: SqliteDb, input: UpsertProviderKeyInput): void {
  db.prepare(
    `INSERT INTO provider_keys(provider, label, secret_ref, enabled, created_at)
     VALUES(?, ?, ?, 1, ?)
     ON CONFLICT(provider, label) DO UPDATE SET secret_ref = excluded.secret_ref, enabled = 1`,
  ).run(input.provider, input.label ?? '主', input.secretRef, input.now);
}

export function deleteProviderKey(db: SqliteDb, provider: string, label = '主'): void {
  db.prepare('DELETE FROM provider_keys WHERE provider = ? AND label = ?').run(provider, label);
}
