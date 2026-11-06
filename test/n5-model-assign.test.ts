/**
 * 009（N5 余账，2026-10-16）：**任务级模型**（指派链最高档：任务级 > 员工级 > 角色映射 > 全局）
 * ＋ **项目白名单拦点**（08 §10.3：`allowed_providers` 非空时供应商必须落在白名单内）。
 *
 * 口径：`08 §10.1`「指派（谁用哪个）」；纯逻辑链在 `core/model-tiers`（本测同批加 ⓪ 用例）。
 * 真库（内存）＋真 handler；只断事实（列值/回执/拒绝）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleChatSend, handleTaskCreate, parseModelCommand, providerOfModel } from '../src/main/ipc/ipc.js';
import type { IpcDeps } from '../src/main/ipc/ipc.js';

const AT = 1_800_000_000_000;

function fixture(): { db: ReturnType<typeof openMemoryDatabase>; deps: IpcDeps } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const repo = createSqliteChatRepo(db);
  return { db, deps: { repo } };
}

test('任务级模型：建任务带 model 落库＋DTO；`模型 T1042 X` 写入/「默认」清除；简写归一', async () => {
  const f = fixture();
  try {
    const created = await handleTaskCreate(f.deps, { goal: '带模型的任务', model: 'deepseek/deepseek-v4-pro' });
    assert.equal(created.model, 'deepseek/deepseek-v4-pro', '建任务即带任务级模型（链路最高档）');
    const bare = await handleTaskCreate(f.deps, { goal: '不带' });
    assert.equal(bare.model, null, '未指派 ⇒ null（不臆造）');

    // 命令（简写 T1001→T-1001 归一）：写入
    const short = created.shortId ?? '';
    const r1 = await handleChatSend(f.deps, { text: `模型 ${short} local/ollama-x` }, AT);
    assert.equal(r1.ok, true);
    assert.equal(f.deps.repo.getTask(created.id)?.model, 'local/ollama-x', '命令真写入 tasks.model');
    const out1 = f.deps.repo.listMessages({ taskId: created.id }).filter((m) => m.direction === 'out').at(-1);
    assert.match(out1?.content ?? '', /任务级模型设为 local\/ollama-x/, '回执点名（人话）');

    // 清除 → 回既有链
    await handleChatSend(f.deps, { text: `模型 ${short} 默认` }, AT + 1);
    assert.equal(f.deps.repo.getTask(created.id)?.model, null, '「默认」＝清除');

    // 短号查无 → 不当命令吞掉（落回常规链，消息照落）
    const r3 = await handleChatSend(f.deps, { text: '模型 T9999 xx/yy' }, AT + 2);
    assert.equal(r3.ok, true);
    assert.equal(r3.resolution.kind, 'chat', '未知短号不拦（落回）');
    assert.ok(f.deps.repo.listMessages().some((m) => m.direction === 'in' && m.content.includes('T9999')), '消息照落不丢');
  } finally {
    f.db.close();
  }
});

test('项目白名单拦点（§10.3）：命令违例拒（回执＋未改）；白名单内放行；建任务违例响亮拒；providerOfModel 纯判据', async () => {
  const f = fixture();
  try {
    f.db
      .prepare("INSERT INTO projects(id, name, root_dir, created_at, allowed_providers) VALUES(7, '敏感项目', 'D:/x', 1, '[\"local\"]')")
      .run();
    const task = f.deps.repo.createTask({ projectId: 7, title: 't', goal: 'g' });
    const short = task.shortId ?? '';

    // 命令路径：违例 → 回执拒绝，列不改
    await handleChatSend(f.deps, { text: `模型 ${short} deepseek/deepseek-v4-pro` }, AT);
    assert.equal(f.deps.repo.getTask(task.id)?.model, null, '违例不得写入');
    const rej = f.deps.repo.listMessages({ taskId: task.id }).filter((m) => m.direction === 'out').at(-1);
    assert.match(rej?.content ?? '', /白名单内/, '回执点名白名单');
    assert.match(rej?.content ?? '', /这条没改/, '回执声明未改动');

    // 白名单内 → 放行
    await handleChatSend(f.deps, { text: `模型 ${short} local/ollama-y` }, AT + 1);
    assert.equal(f.deps.repo.getTask(task.id)?.model, 'local/ollama-y');

    // 建任务路径：违例 → 响亮拒（throw 带人话）
    await assert.rejects(
      () => handleTaskCreate(f.deps, { goal: 'g', projectId: 7, model: 'anthropic/claude-x' }),
      /白名单/,
      'task:create 违例必须响亮（不静默落库）',
    );

    // 纯判据
    assert.equal(providerOfModel('deepseek/deepseek-v4-pro'), 'deepseek');
    assert.equal(providerOfModel('local'), 'local', '无斜杠整串即供应商（不猜拆）');
    assert.deepEqual(parseModelCommand('模型 T1042 deepseek/x'), { shortId: 'T-1042', model: 'deepseek/x' });
    assert.deepEqual(parseModelCommand('模型 T1042 清除'), { shortId: 'T-1042', model: null });
    assert.equal(parseModelCommand('模型 不是短号 x'), null);
  } finally {
    f.db.close();
  }
});
