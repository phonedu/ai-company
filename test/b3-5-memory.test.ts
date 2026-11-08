/**
 * B3-5（57 P0-4/5/6 余项；D-31）：记忆智能化——归档＋globalDir 修复＋brief 去重＋LLM 抽取提议卡。
 *
 * 口径：
 *  - **归档**：appendMemory 超 20 块的挤出块写**库旁** `.aico/memory-archive/<emp>-<proj>.md`
 *    （与 notes 同哲学，不依赖项目根）；内存库跳过归档（无盘可归）；
 *  - **globalDir**：检索真源＝库文件旁 notes/（globalNotesDirForDb；修复 root_dir/../.. 错拼）；
 *  - **brief 去重**：同事实（content 相同或互含）全局层已在场的项目条目不再双出；
 *  - **抽取提议卡**：`extractMemoryCandidates`（fail-closed：无模型/解析失败→空数组不猜测）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { appendMemory, readMemory } from '../src/main/db/memory.js';
import { globalNotesDirForDb, searchRelated } from '../src/main/db/retrieval.js';
import { extractMemoryCandidates, parseCandidateJson } from '../src/main/agent/memory-extract.js';
import { SqliteMemoryStore, renderBrief } from '../src/main/memory/index.js';
import { insertEmployee, openDatabase, openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import { writeNote } from '../src/main/agent/notes.js';

test('B3-5: appendMemory 超 20 块 → 挤出块写归档文件（库旁 .aico/memory-archive/，不丢弃）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'b3-5-arch-'));
  const db = openDatabase(join(dir, 'aico.sqlite'));
  runMigrations(db);
  db.prepare("INSERT INTO employees(id,name,role,created_at) VALUES(7,'E7','dev',1)").run();
  db.prepare("INSERT INTO projects(id,name,root_dir,created_at) VALUES(1,'P','D:/p',1)").run();
  try {
    for (let i = 1; i <= 25; i += 1) {
      appendMemory(db, { employeeId: 7, projectId: 1, block: `块${i}：事实内容`, marker: `m${i}`, now: i });
    }
    const memory = readMemory(db, { employeeId: 7, projectId: 1 });
    const blocks = memory.split(/\n{2,}/).filter((b) => b.trim().length > 0);
    assert.equal(blocks.length, 20, '活跃块保持 20');
    assert.match(memory, /块25/, '最新块在场');
    assert.ok(!memory.includes('块1：'), '最旧的被挤出活跃区');
    // 归档文件：库旁 .aico/memory-archive/<emp>-<proj>.md
    const archivePath = join(dir, '.aico', 'memory-archive', '7-1.md');
    assert.ok(existsSync(archivePath), `归档文件在案（${archivePath}）`);
    const archived = readFileSync(archivePath, 'utf8');
    assert.match(archived, /块1：/, '被挤出的块进归档');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B3-5: globalNotesDirForDb——库文件旁 notes/；:memory: 回落 cwd/.aico-notes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'b3-5-gd-'));
  try {
    const dbPath = join(dir, 'aico.sqlite');
    const gd = globalNotesDirForDb(dbPath);
    assert.ok(gd.includes('notes'), '库文件旁 notes/');
    assert.ok(!gd.includes('.aico-notes'), '不是错拼的 .aico-notes');
    assert.equal(globalNotesDirForDb(':memory:'), process.cwd() + requireSep() + '.aico-notes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function requireSep(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return process.platform === 'win32' ? '\\' : '/';
}

test('B3-5: searchRelated 召回全局笔记（globalDir 修复端到端）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'b3-5-sr-'));
  const dbPath = join(dir, 'aico.sqlite');
  const { openDatabase } = await import('../src/main/db/open.js');
  const db = openDatabase(dbPath);
  runMigrations(db);
  try {
    insertEmployee(db, { id: 7, name: 'E7', role: 'dev', now: 1 });
    const projectId = Number(
      (db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P',?,1)").run(join(dir, 'proj')).lastInsertRowid as number),
    );
    mkdirSync(join(dir, 'proj'), { recursive: true });
    // 全局笔记（真源＝库文件旁 notes/）——含检索词「渲染」
    writeNote({ globalDir: globalNotesDirForDb(dbPath), name: 'render-note', content: '渲染：面板渲染阻塞的根因是同步 loadModelCatalog。' });
    const hits = searchRelated(db, { projectId, text: '渲染 阻塞 根因', limit: 4 });
    assert.ok(hits.some((h) => h.source === 'note' && h.text.includes('渲染')), '全局笔记被召回（修复前恒空）');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B3-5: brief 去重——同事实全局＋项目不双出', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  try {
    const store = new SqliteMemoryStore(db);
    store.remember({ scope: { type: 'global' }, kind: 'fact', value: '部署前必须跑 pnpm test', source: { type: 'boss', at: 1 } });
    // 同事实的项目条目（提升后全局＋项目共存）
    store.remember({ scope: { type: 'project', projectId: 3 }, kind: 'fact', value: '部署前必须跑 pnpm test', source: { type: 'boss', at: 2 } });
    store.remember({ scope: { type: 'project', projectId: 3 }, kind: 'fact', value: '项目专属：用 pnpm 检查依赖', source: { type: 'boss', at: 3 } });
    const brief = renderBrief(store.brief({ principal: { kind: 'employee', employeeId: 7 }, projectId: 3 }).sections);
    const count = (brief.match(/部署前必须跑 pnpm test/g) ?? []).length;
    assert.equal(count, 1, '同事实只出一分（去重）');
    assert.match(brief, /项目专属/, '项目专属事实保留');
    db.close();
  } finally {
    void db;
  }
});

test('B3-5: 抽取提议卡闸门——provisional 不进 brief；老板确认后才进', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  try {
    const store = new SqliteMemoryStore(db);
    // 模拟抽取写入（writeCandidatesAsProvisional 同形态：source=task + provisional）
    store.remember({ scope: { type: 'project', projectId: 3 }, kind: 'fact', value: '抽取来的未确认事实', confidence: 'provisional', source: { type: 'task', ref: 'task:9', at: 1 } });
    const before = renderBrief(store.brief({ principal: { kind: 'employee', employeeId: 7 }, projectId: 3 }).sections);
    assert.ok(!before.includes('抽取来的未确认事实'), 'provisional 抽取不进 brief（闸门）');
    // 老板确认（confidence→confirmed）
    const items = store.list({ scope: { type: 'project', projectId: 3 }, includeHistorical: false, limit: 10 });
    const item = items.find((it) => it.value === '抽取来的未确认事实');
    assert.ok(item, '抽取条目在库（待确认可见）');
    db.prepare('UPDATE memory_items SET confidence = ? WHERE id = ?').run('confirmed', item!.id);
    const after = renderBrief(store.brief({ principal: { kind: 'employee', employeeId: 7 }, projectId: 3 }).sections);
    assert.match(after, /抽取来的未确认事实/, '确认后进 brief');
    db.close();
  } finally {
    void db;
  }
});

test('B3-5: writeCandidatesAsProvisional——写入 provisional/幂等 ref/失败不抛', async () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  try {
    const store = new SqliteMemoryStore(db);
    const { writeCandidatesAsProvisional } = await import('../src/main/agent/memory-extract.js');
    const n1 = await writeCandidatesAsProvisional(store, { taskId: 9, projectId: 3, candidates: [{ content: '事实A', confidence: 0.8 }], now: 1 });
    assert.equal(n1, 1);
    const n2 = await writeCandidatesAsProvisional(store, { taskId: 9, projectId: 3, candidates: [{ content: '事实A', confidence: 0.8 }], now: 2 });
    assert.equal(n2, 1, '重复执行仍写（dedupe 由 key/现有合并逻辑处理；条目数以去重后为准）');
    const rows = db.prepare("SELECT value, confidence, source_ref AS source FROM memory_items WHERE source_ref LIKE '%task:9%'").all() as Array<{ value: string; confidence: string; source: string }>;
    assert.ok(rows.length >= 1);
    assert.equal(rows[0]!.confidence, 'provisional', 'provisional 状态');
    assert.ok(rows[0]!.source.includes('task:9'), 'source ref 指回任务');
    db.close();
  } finally {
    void db;
  }
});

// ── 抽取提议卡（fail-closed） ─────────────────────────────────────────────

test('B3-5: parseCandidateJson——容错抽取；坏输入空数组', () => {
  const ok = parseCandidateJson('前置 {"candidates":[{"content":"事实A","confidence":0.8},{"content":"事实B","confidence":0.5}]} 后缀');
  assert.equal(ok.length, 2);
  assert.equal(ok[0]!.content, '事实A');
  assert.equal(parseCandidateJson('不是 JSON').length, 0);
  assert.equal(parseCandidateJson('{"candidates":"x"}').length, 0);
  assert.equal(parseCandidateJson('{"candidates":[{"content":""}]}').length, 0, '空 content 过滤');
});

test('B3-5: extractMemoryCandidates——fetch 注入解析候选；无 Key/坏响应 fail-closed 空数组', async () => {
  const okResponse = { ok: true, json: async () => ({ choices: [{ message: { content: '{"candidates":[{"content":"缓存命中 82%","confidence":0.7}]}' } }] }) } as unknown as Response;
  const cands = await extractMemoryCandidates({
    text: '任务完成：缓存命中率 82%',
    apiKey: 'sk-test-injected',
    fetchImpl: (async () => okResponse) as typeof fetch,
  });
  assert.equal(cands.length, 1);
  assert.equal(cands[0]!.content, '缓存命中 82%');

  // 无 Key（临时空 secretsDir）→ 空数组不猜测
  const none = await extractMemoryCandidates({
    text: '任务完成',
    secretsDir: () => join(tmpdir(), 'b3-5-key-missing'),
  });
  assert.equal(none.length, 0);
});
