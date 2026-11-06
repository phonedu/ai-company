/**
 * OPT-AI-10 · MCP 客户端最小闭环（真 stdio 子进程）：
 *  - `upsertMcpServer` → `listMcpTools`（initialize ＋ tools/list）；
 *  - `callMcpTool`（tools/call）返回子进程结果；
 *  - IPC `mcp:set/list` 注册与列表；
 *  - 闸门分类：`mcp_call` = external（逐次批准），`mcp_list` = manage（只读）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openMemoryDatabase, runMigrations, upsertMcpServer, type SqliteDb } from '../src/main/db/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleMcpList, handleMcpSet, type IpcDeps } from '../src/main/ipc/ipc.js';
import { callMcpTool, listMcpTools } from '../src/main/agent/mcp-client.js';
import { toolCategory } from '../src/main/permission/gate.js';

const FAKE_SERVER = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  let result = {};
  if (msg.method === 'initialize') {
    result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0.0' } };
  } else if (msg.method === 'tools/list') {
    result = { tools: [{ name: 'echo', description: 'echo back', inputSchema: { type: 'object' } }] };
  } else if (msg.method === 'tools/call') {
    result = { content: [{ type: 'text', text: 'echo:' + JSON.stringify(msg.params && msg.params.arguments) }] };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
});
`;

function setup(): { db: SqliteDb; dir: string; script: string } {
  const dir = mkdtempSync(join(tmpdir(), 'aico-mcp-'));
  const script = join(dir, 'fake-mcp.cjs');
  writeFileSync(script, FAKE_SERVER, 'utf8');
  const db = openMemoryDatabase();
  runMigrations(db);
  return { db, dir, script };
}

test('OPT-AI-10：stdio MCP 列表与调用（真子进程；JSON-RPC 握手）', async () => {
  const { db, dir, script } = setup();
  const row = upsertMcpServer(db, {
    name: 'fake',
    transport: 'stdio',
    command: process.execPath,
    args: [script],
    now: 1,
  });
  const listed = await listMcpTools(row);
  assert.equal(listed.ok, true, JSON.stringify(listed));
  if (!listed.ok) return;
  assert.equal(listed.tools[0]?.name, 'echo');

  const called = await callMcpTool(row, 'echo', { text: 'hi' });
  assert.equal(called.ok, true, JSON.stringify(called));
  if (!called.ok) return;
  assert.match(JSON.stringify(called.content), /echo:/);
  assert.match(JSON.stringify(called.content), /hi/);

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('OPT-AI-10：mcp:set/list 注册与列表；缺 command/url 拒绝（不落库）', () => {
  const { db, dir, script } = setup();
  const deps = { repo: createSqliteChatRepo(db) } as IpcDeps;
  const bad = handleMcpSet(deps, { name: 'x', transport: 'stdio' });
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.equal(bad.code, 'bad_request');

  const ok = handleMcpSet(deps, { name: 'fake', transport: 'stdio', command: process.execPath, args: [script] });
  assert.equal(ok.ok, true);
  const rows = handleMcpList(deps, {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.name, 'fake');
  assert.equal(rows[0]!.transport, 'stdio');
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('OPT-AI-10：闸门分类（mcp_call 逐次批准；mcp_list 只读）', () => {
  assert.equal(toolCategory('mcp_call'), 'external');
  assert.equal(toolCategory('mcp_list'), 'manage');
});
