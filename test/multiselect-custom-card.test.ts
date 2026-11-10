/**
 * 多选＋自定义作答卡（2026-10-28 指令：AI 列的选项单选/多选都可能不满足，必须有自己写的方式）。
 *
 * 口径：
 * - `payload.selection === 'multi'` → 选项变可勾选，提交按钮统一作答，chosen＝勾选键 `k1+k2`（号连接）；
 *   单选（缺省）保持点即答不变；
 * - 决策/普通 ask 卡（选项非机器键）→ 附「自定义作答」文本入口，chosen＝原文；
 *   批准卡（approve/revise）与权限卡（approve_once/…）的键绑定机器事件，**不给**自定义；
 * - 员工 `escalate_to_boss` 可声明 `selection`（single/multi），引擎透传上卡；
 * - 待我处理行：多选卡不做行内即点（会误答），引导「在频道作答」（focusChannelCard）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { customAnswerAllowed, isMultiSelect, multiChosen } from '../src/renderer/components/cardAnswer.js';
import { approvalAnswerEvent } from '../src/main/ipc/ipc.js';
import { SqliteCounterStore, createTask, openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import { Engine, makeRecordingExecutor } from '../src/main/engine/index.js';
import type { SqliteDb } from '../src/main/db/index.js';

// ── 纯函数：选择模式判定与作答串 ────────────────────────────────────────────

test('多选① payload.selection=multi → 多选；缺省/single → 单选', () => {
  assert.equal(isMultiSelect({ selection: 'multi' }), true);
  assert.equal(isMultiSelect({ selection: 'single' }), false);
  assert.equal(isMultiSelect({}), false);
  assert.equal(isMultiSelect({ selection: 'banana' }), false, '未知值不猜＝单选');
});

test('多选② chosen＝勾选键按 + 连接（提交时统一作答）', () => {
  assert.equal(multiChosen(['clean-a', 'clean-b']), 'clean-a+clean-b');
  assert.equal(multiChosen(['x']), 'x');
});

test('多选③ 自定义入口：决策/普通 ask 且带选项 → 允许；批准/权限卡（机器键）→ 不允许', () => {
  const decision = customAnswerAllowed({ kind: 'ask', payload: { card: 'decision', options: [{ key: 'a' }] } });
  assert.equal(decision, true, '决策卡允许自定义');
  const plainAsk = customAnswerAllowed({ kind: 'ask', payload: { options: [{ key: 'a' }] } });
  assert.equal(plainAsk, true, '无 card 字段的普通 ask 允许');
  const approval = customAnswerAllowed({ kind: 'ask', payload: { card: 'approval', options: [{ key: 'approve' }] } });
  assert.equal(approval, false, '批准卡键绑定机器事件，不允许');
  const permission = customAnswerAllowed({ kind: 'ask', payload: { card: 'permission', options: [{ key: 'deny' }] } });
  assert.equal(permission, false, '权限卡不允许');
  const noOptions = customAnswerAllowed({ kind: 'ask', payload: { card: 'decision' } });
  assert.equal(noOptions, false, '没有选项列表＝没有「都不满意」问题，不显示入口');
  const report = customAnswerAllowed({ kind: 'report', payload: {} });
  assert.equal(report, false, 'report 卡无作答语义');
});

// ── 作答映射：多选串/自定义原文都走 decision_made（chosen 透传） ─────────────

test('多选④ needs_decision 收到 k1+k2 ／自定义原文 → 均 decision_made（chosen 原样落台账）', () => {
  assert.deepEqual(approvalAnswerEvent('needs_decision', 'clean-a+clean-b'), {
    event: 'decision_made',
    payload: { chosen: 'clean-a+clean-b' },
  });
  assert.deepEqual(approvalAnswerEvent('needs_decision', '两个都不选，先跑第三方案'), {
    event: 'decision_made',
    payload: { chosen: '两个都不选，先跑第三方案' },
  });
});

// ── 引擎透传：escalate 带 selection=multi + options → 卡 payload 同源 ────────

test('多选⑤ 员工升级声明 multi → 决策卡 payload 带 selection=multi 与 options', async () => {
  const db: SqliteDb = openMemoryDatabase();
  runMigrations(db);
  try {
    const projectId = Number(
      db.prepare("INSERT INTO projects(name, root_dir, created_at) VALUES('P','D:/p',1)").run().lastInsertRowid,
    );
    const task = createTask(db, new SqliteCounterStore(db), { projectId, title: 't', goal: 'g', now: 1 });
    const engine = new Engine(db, makeRecordingExecutor(), { autoSchedule: false, now: () => 1 });
    await engine.dispatch({ scope: 'task', id: task.id, event: 'triage' });
    await engine.dispatch({
      scope: 'task',
      id: task.id,
      event: 'escalate',
      actor: 'employee:1',
      payload: {
        question: '要清理哪些临时目录？（可多选）',
        selection: 'multi',
        options: [
          { key: 'clean-tmp', label: '清理 tmp' },
          { key: 'clean-log', label: '清理 log' },
        ],
        employeeId: 1,
        via: 'escalate_to_boss',
        urgent: true,
        notifyRevision: 1001,
      },
    });
    const row = db
      .prepare("SELECT payload FROM reports WHERE task_id = ? AND kind = 'ask' ORDER BY id DESC LIMIT 1")
      .get(task.id) as { payload: string };
    const card = JSON.parse(row.payload) as { selection?: string; options?: Array<{ key: string }> };
    assert.equal(card.selection, 'multi', 'selection 透传上卡');
    assert.deepEqual((card.options ?? []).map((o) => o.key), ['clean-tmp', 'clean-log'], 'options 透传上卡');
  } finally {
    db.close();
  }
});

// ── 源码守卫：渲染接线 ──────────────────────────────────────────────────────

test('多选⑥ Card 渲染：多选 toggle＋提交按钮＋自定义入口；单选即点保持', () => {
  const src = readFileSync('src/renderer/components/Card.tsx', 'utf8');
  assert.match(src, /isMultiSelect/, '判定接入');
  assert.match(src, /card-multi-submit/, '多选提交按钮');
  assert.match(src, /multiChosen\(/, '多选作答串');
  assert.match(src, /card-custom-toggle/, '自定义入口');
  assert.match(src, /card-custom-submit/, '自定义提交');
  assert.match(src, /customAnswerAllowed/, '自定义判定接入');
});

test('多选⑦ 待我处理行：多选卡不做行内即点，引导去频道（focusChannelCard）', () => {
  const src = readFileSync('src/renderer/components/InboxView.tsx', 'utf8');
  assert.match(src, /isMultiSelect/, '多选判定接入');
  assert.match(src, /inbox-multi-goto/, '多选引导按钮');
  // 多选行内不直接 answerCard（防止误答）：多选分支里不得出现 answerCard
  const m = src.match(/isMultiSelect[\s\S]{0,600}?focusChannelCard/);
  assert.ok(m != null, '多选分支必须走 focusChannelCard');
  assert.doesNotMatch(m[0], /answerCard/, '多选分支不得行内即答');
});

test('多选⑧ escalate_to_boss 工具 schema 声明 selection（员工可问多选题）', () => {
  const tool = readFileSync('src/main/agent/escalate-to-boss-tool.ts', 'utf8');
  assert.match(tool, /selection/, '工具带 selection 参数');
});
