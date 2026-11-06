/**
 * OPT-AI-10 · MCP server 库 DAO（`mcp_servers` 表；此前表在、零客户端/零写入者）。
 *
 * 口径：
 *  - 注册＝老板显式给 `{name, transport, command|url, args, env, exposure, has_external_actions}`；
 *  - 凭据在 `env` JSON（本机 `~/.aico` 口径；UI 掩码/加密属后续，不在本文件）；
 *  - 客户端每次调用**短连**（spawn/HTTP → initialize → tools/call → 关闭）；不做常驻池（v1）。
 */
import type { SqliteDb } from './open.js';

export interface McpServerRow {
  id: number;
  name: string;
  transport: string;
  command: string | null;
  args: string;
  url: string | null;
  env: string;
  exposure: string;
  has_external_actions: number;
  enabled: number;
  created_at: number;
}

const COLUMNS = 'id, name, transport, command, args, url, env, exposure, has_external_actions, enabled, created_at';

export function listMcpServers(db: SqliteDb, options: { includeDisabled?: boolean } = {}): McpServerRow[] {
  const where = options.includeDisabled ? '' : ' WHERE enabled = 1';
  return db.prepare(`SELECT ${COLUMNS} FROM mcp_servers${where} ORDER BY name`).all() as McpServerRow[];
}

export function getMcpServerByName(db: SqliteDb, name: string): McpServerRow | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM mcp_servers WHERE name = ?`).get(name) as McpServerRow | undefined;
}

export interface UpsertMcpServerInput {
  name: string;
  transport: 'stdio' | 'http';
  command?: string | null;
  args?: string[];
  url?: string | null;
  env?: Record<string, string>;
  exposure?: 'auto' | 'direct' | 'deferred' | 'codemode';
  hasExternalActions?: boolean;
  enabled?: boolean;
  now?: number;
}

/** GAP6：按员工/项目引用（id 或名字）解析**启用中**的 MCP server；未登记/停用忽略。 */
export function resolveEnabledMcpServers(db: SqliteDb, refs: readonly string[]): McpServerRow[] {
  const out: McpServerRow[] = [];
  const seen = new Set<number>();
  for (const ref of refs) {
    const row = /^\d+$/.test(ref)
      ? (db.prepare(`SELECT ${COLUMNS} FROM mcp_servers WHERE id = ?`).get(Number(ref)) as McpServerRow | undefined)
      : getMcpServerByName(db, ref);
    if (!row || row.enabled !== 1 || seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

export function getMcpServerById(db: SqliteDb, id: number): McpServerRow | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM mcp_servers WHERE id = ?`).get(id) as McpServerRow | undefined;
}

export function setMcpServerEnabled(db: SqliteDb, id: number, enabled: boolean): McpServerRow | undefined {
  db.prepare('UPDATE mcp_servers SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  return getMcpServerById(db, id);
}

/** 被员工引用次数（id 或名字两种写法都算）；删除前提示/拒绝。 */
export function countMcpReferences(db: SqliteDb, name: string, id: number): number {
  const rows = db.prepare('SELECT mcps FROM employees').all() as Array<{ mcps: string | null }>;
  let n = 0;
  for (const row of rows) {
    try {
      const refs = JSON.parse(row.mcps ?? '[]') as unknown;
      if (Array.isArray(refs) && refs.some((r) => String(r) === name || String(r) === String(id))) n += 1;
    } catch {
      /* 坏配置不算引用 */
    }
  }
  return n;
}

export function deleteMcpServer(db: SqliteDb, id: number): McpServerRow | undefined {
  const row = getMcpServerById(db, id);
  if (!row) return undefined;
  db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
  return row;
}

export function upsertMcpServer(db: SqliteDb, input: UpsertMcpServerInput): McpServerRow {
  db.prepare(
    `INSERT INTO mcp_servers(name, transport, command, args, url, env, exposure, has_external_actions, enabled, created_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       transport = excluded.transport, command = excluded.command, args = excluded.args, url = excluded.url,
       env = excluded.env, exposure = excluded.exposure, has_external_actions = excluded.has_external_actions,
       enabled = excluded.enabled`,
  ).run(
    input.name,
    input.transport,
    input.command ?? null,
    JSON.stringify(input.args ?? []),
    input.url ?? null,
    JSON.stringify(input.env ?? {}),
    input.exposure ?? 'auto',
    input.hasExternalActions ? 1 : 0,
    input.enabled === false ? 0 : 1,
    input.now ?? Date.now(),
  );
  const row = getMcpServerByName(db, input.name);
  if (!row) throw new Error(`[db] upsertMcpServer 后读回失败：${input.name}`);
  return row;
}
