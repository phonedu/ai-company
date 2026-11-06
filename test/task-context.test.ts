/**
 * UG-01 · 任务上下文（目标/项目/负责人/截止/依赖）纯函数 + DTO 真库回读。
 *
 * 口径：只读 `task:get`；不新增表/通道；无数据显式 `未设置/未指定/无`，不写假 0。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDatabase } from '../src/main/db/open.js';
import { runMigrations } from '../src/main/db/migrate.js';
import { insertEmployee } from '../src/main/db/employees.js';
import { handleTaskGet, type IpcDeps, type TaskDetailDTO } from '../src/main/ipc/ipc.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import {
  dependencySummary,
  formatDeadline,
  forcedSkillOf,
  ownerDisplay,
} from '../src/renderer/components/taskContext.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

test('UG-01 formatDeadline：未设置 / 剩余 / 临期 / 逾期四态（真读数，不写假 0）', () => {
  const now = Date.UTC(2026, 9, 25, 4, 0, 0);
  assert.deepEqual(formatDeadline(null, now), { date: '未设置', relative: '', tone: 'none', overdue: false });
  assert.deepEqual(formatDeadline(0, now), { date: '未设置', relative: '', tone: 'none', overdue: false });

  const later = formatDeadline(now + 5 * DAY, now);
  assert.equal(later.relative, '剩 5 天');
  assert.equal(later.tone, 'normal');
  assert.equal(later.overdue, false);

  const soon = formatDeadline(now + 2 * DAY, now);
  assert.equal(soon.relative, '剩 2 天');
  assert.equal(soon.tone, 'warn');

  const hours = formatDeadline(now + 2 * HOUR, now);
  assert.equal(hours.relative, '剩 2 小时');
  assert.equal(hours.tone, 'warn');

  const late = formatDeadline(now - 2 * HOUR, now);
  assert.equal(late.relative, '已逾期 2 小时');
  assert.equal(late.tone, 'danger');
  assert.equal(late.overdue, true);
});

test('UG-01 ownerDisplay：负责人与执行员工分开；都没有 → 未指定', () => {
  assert.deepEqual(ownerDisplay({ id: 1, name: '林悦' }, { id: 2, name: '陈默' }), {
    name: '林悦',
    meta: '执行：陈默',
    title: '负责人：林悦（执行：陈默）',
  });
  // UG-01（D4 must-fix）：owner 未设置 → 显「未指定」；执行员工只在 meta 说明，不顶替负责人。
  assert.deepEqual(ownerDisplay(null, { id: 2, name: '陈默' }), {
    name: '未指定',
    meta: '执行：陈默',
    title: '未指定负责人（按编制/缺省链）；执行：陈默',
  });
  assert.deepEqual(ownerDisplay(null, null), {
    name: '未指定',
    meta: null,
    title: '未指定负责人（按编制/缺省链）',
  });
});

test('UG-01 dependencySummary：最多 3 个短号 + 完成态；超过折叠 +N；无 → 无', () => {
  assert.deepEqual(dependencySummary([]), { text: '无', title: '无前置任务' });
  const deps = [
    { id: 1, shortId: 'T-1001', title: '甲', state: 'done' },
    { id: 2, shortId: 'T-1002', title: '乙', state: 'executing' },
    { id: 3, shortId: null, title: '丙', state: 'queued' },
    { id: 4, shortId: 'T-1004', title: '丁', state: 'blocked' },
  ];
  const summary = dependencySummary(deps);
  assert.equal(summary.text, 'T-1001 ✓ · T-1002 · #3 · +1');
  assert.match(summary.title, /T-1001 · 甲 · done/);
  assert.match(summary.title, /#3 · 丙 · queued/);
});

test('UG-01 forcedSkillOf：最后一条 task_skill_forced 为准；清除后 null', () => {
  assert.equal(forcedSkillOf([]), null);
  const timeline = [
    { id: 1, ts: 1, kind: 'task_skill_forced', actor: 'boss', payload: { skill: 'old-skill' } },
    { id: 2, ts: 2, kind: 'task_skill_forced', actor: 'boss', payload: { skill: 'new-skill' } },
  ] as never;
  assert.equal(forcedSkillOf(timeline), 'new-skill');
  const cleared = [
    ...timeline,
    { id: 3, ts: 3, kind: 'task_skill_forced', actor: 'boss', payload: { skill: null } },
  ] as never;
  assert.equal(forcedSkillOf(cleared), null);
});

test('UG-01 真库：task:get 返回 owner / dependsOn / deadline / goal（不是只存不读）', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  const deps: IpcDeps = { repo: createSqliteChatRepo(db) };
  const ownerId = insertEmployee(db, { name: '林悦', role: 'engineer', now: 1 });
  const deadline = Date.now() + 6 * DAY;

  const dependency = deps.repo.createTask({ title: '前置任务', goal: '前置任务', riskLevel: 0 });
  const main = deps.repo.createTask({
    title: '竞品对账脚本调研与实现',
    goal: '把 3 家竞品的导出格式整理成可核对脚本，并补上 pytest。',
    riskLevel: 0,
    ownerId,
    deadline,
    dependsOn: [dependency.id],
  });

  const detail = handleTaskGet(deps, { taskId: main.id }) as TaskDetailDTO;
  assert.ok(detail);
  assert.equal(detail.task.goal, '把 3 家竞品的导出格式整理成可核对脚本，并补上 pytest。');
  assert.equal(detail.task.deadline, deadline);
  assert.equal(detail.owner?.id, ownerId);
  assert.equal(detail.owner?.name, '林悦');
  assert.deepEqual(
    detail.dependsOn.map((item) => ({ id: item.id, shortId: item.shortId, state: item.state })),
    [{ id: dependency.id, shortId: dependency.shortId, state: dependency.state }],
  );
  db.close();
});

test('UG-01 真库：无负责人/无依赖/无截止 → null / 空数组（不臆造）', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  const deps: IpcDeps = { repo: createSqliteChatRepo(db) };
  const created = deps.repo.createTask({ title: '裸任务', goal: '裸任务', riskLevel: 0 });
  const detail = handleTaskGet(deps, { taskId: created.id }) as TaskDetailDTO;
  assert.equal(detail.owner, null);
  assert.deepEqual(detail.dependsOn, []);
  assert.equal(detail.task.deadline, null);
  db.close();
});
