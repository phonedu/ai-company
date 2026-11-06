/**
 * M3-N-4 · GAP6/B4/B5：MCP 分配白名单、凭据校验/脱敏、deferred 不预列、tool_search。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  insertEmployee,
  openMemoryDatabase,
  runMigrations,
  upsertMcpServer,
  type SqliteDb,
} from '../src/main/db/index.js';
import { buildEmployeeContext } from '../src/main/agent/context.js';
import { clearSessionMcpServers, createMcpTools, setSessionMcpServers } from '../src/main/agent/mcp-tool.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleMcpAction, handleMcpList, handleMcpSet, type IpcDeps } from '../src/main/ipc/ipc.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'aico-mcp-n4-'));
  const script = join(dir, 'fake-mcp.cjs');
  writeFileSync(script, FAKE_SERVER, 'utf8');
  const db = openMemoryDatabase();
  runMigrations(db);
  insertEmployee(db, { id: 1, name: '实施', role: 'engineer', mcps: ['assigned'], now: 1 });
  insertEmployee(db, { id: 2, name: '别人', role: 'writer', mcps: ['other'], now: 1 });
  return { db, dir, script };
}

test('GAP6 分配：context 只拿员工 mcps∩启用；[MCP 服务] 不泄露别人的 server', () => {
  const { db, dir, script } = setup();
  try {
    upsertMcpServer(db, { name: 'assigned', transport: 'stdio', command: process.execPath, args: [script], exposure: 'direct', now: 1 });
    upsertMcpServer(db, { name: 'other', transport: 'stdio', command: process.execPath, args: [script], now: 1 });
    upsertMcpServer(db, { name: 'off', transport: 'stdio', command: process.execPath, args: [script], enabled: false, now: 1 });
    db.prepare('INSERT INTO projects(id,name,root_dir,created_at) VALUES(1,?,?,1)').run('P', join(dir, 'project'));
    db.prepare(
      "INSERT INTO tasks(id,short_id,project_id,title,goal,acceptance,state,created_at,updated_at) VALUES(1,'T-1001',1,'T','g','[]','executing',1,1)",
    ).run();
    const ctx = buildEmployeeContext(db, { employeeId: 1, taskId: 1 });
    assert.deepEqual(ctx.meta.mcpRefs, ['assigned']);
    assert.match(ctx.systemPrompt, /\[MCP 服务\][\s\S]*assigned/);
    assert.doesNotMatch(ctx.systemPrompt, /- other（stdio/);
    assert.doesNotMatch(ctx.systemPrompt, /- off（stdio/);

    db.prepare("UPDATE employees SET mcps='[\"off\"]' WHERE id=1").run();
    assert.deepEqual(buildEmployeeContext(db, { employeeId: 1, taskId: 1 }).meta.mcpRefs, [], '停用 server 不交付');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GAP6/B5：mcp_list 只看本会话分配；deferred 不预列；tool_search 按需发现；mcp_call 越权拒', async () => {
  const { db, dir, script } = setup();
  try {
    upsertMcpServer(db, { name: 'assigned', transport: 'stdio', command: process.execPath, args: [script], exposure: 'direct', now: 1 });
    upsertMcpServer(db, { name: 'other', transport: 'stdio', command: process.execPath, args: [script], exposure: 'deferred', now: 1 });
    const tools = (await createMcpTools(db)) as unknown as Record<
      string,
      { execute: (id: string, args: unknown, s: undefined, u: undefined, ctx: unknown) => Promise<any> }
    >;
    const ctxFor = (id: string) => ({ sessionManager: { getSessionId: () => id } });

    setSessionMcpServers('session-a', ['assigned']);
    const listA = await tools.mcpList!.execute('x', {}, undefined, undefined, ctxFor('session-a'));
    assert.match(listA.content[0].text, /assigned/);
    assert.match(listA.content[0].text, /echo/);
    assert.doesNotMatch(listA.content[0].text, /other/, '未分配 server 不出现');

    setSessionMcpServers('session-b', ['other']);
    const listB = await tools.mcpList!.execute('x', {}, undefined, undefined, ctxFor('session-b'));
    assert.match(listB.content[0].text, /deferred/);
    assert.doesNotMatch(listB.content[0].text, /echo/, 'deferred 不预列工具名');

    const searched = await tools.toolSearch!.execute('x', { query: 'echo' }, undefined, undefined, ctxFor('session-b'));
    assert.match(searched.content[0].text, /other\/echo/, 'tool_search 能发现 deferred 工具');
    const withSchema = await tools.toolSearch!.execute('x', { query: 'echo', includeSchema: true }, undefined, undefined, ctxFor('session-b'));
    assert.match(withSchema.content[0].text, /schema=/, 'includeSchema 返回 schema');

    const denied = await tools.mcpCall!.execute('x', { server: 'assigned', tool: 'echo', arguments: {} }, undefined, undefined, ctxFor('session-b'));
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /未分配给本会话/);

    const called = await tools.mcpCall!.execute('x', { server: 'assigned', tool: 'echo', arguments: { hi: 1 } }, undefined, undefined, ctxFor('session-a'));
    assert.notEqual(called.isError, true);
    assert.match(JSON.stringify(called.content), /echo:/);
  } finally {
    clearSessionMcpServers();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GAP6 注册校验：URL/凭据/env/exposure；列表只回 envKeys 不回值；被引用拒删', () => {
  const { db, dir, script } = setup();
  try {
    const deps = { repo: createSqliteChatRepo(db) } as IpcDeps;
    assert.equal(handleMcpSet(deps, { name: 'bad', transport: 'http', url: 'ftp://x' }).ok, false);
    assert.equal(handleMcpSet(deps, { name: 'bad', transport: 'http', url: 'https://u:p@x' }).ok, false);
    assert.equal(handleMcpSet(deps, { name: 'bad', transport: 'stdio', command: 'x', env: { 'BAD-KEY': 'v' } }).ok, false);
    assert.equal(handleMcpSet(deps, { name: 'bad', transport: 'stdio', command: 'x', exposure: 'wat' }).ok, false);
    const ok = handleMcpSet(deps, {
      name: 'assigned',
      transport: 'stdio',
      command: process.execPath,
      args: [script],
      env: { TOKEN: 'super-secret' },
      exposure: 'direct',
      hasExternalActions: true,
    });
    assert.equal(ok.ok, true);
    const list = handleMcpList(deps, { includeDisabled: true });
    assert.equal(list[0]!.name, 'assigned');
    assert.deepEqual(list[0]!.envKeys, ['TOKEN']);
    assert.equal(JSON.stringify(list).includes('super-secret'), false, 'env 值绝不回 renderer');

    const removed = handleMcpAction(deps, { action: 'remove', id: list[0]!.id });
    assert.equal(removed.ok, false);
    assert.equal(!removed.ok && removed.code, 'in_use', '员工引用中拒删');

    db.prepare("UPDATE employees SET mcps='[]' WHERE id=1").run();
    const toggle = handleMcpAction(deps, { action: 'toggle', id: list[0]!.id, enabled: false });
    assert.equal(toggle.ok, true);
    assert.equal((toggle as { server: { enabled: boolean } }).server.enabled, false);
    const removed2 = handleMcpAction(deps, { action: 'remove', id: list[0]!.id });
    assert.equal(removed2.ok, true);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
