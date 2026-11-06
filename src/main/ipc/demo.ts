/**
 * T0.5 演示数据（**仅 `AICO_T05_DEMO=1` 且库为空时执行**，供 UI 截图基线 / 人工查看）。
 * 不是生产路径；用最小 SQL 造一条「进行中任务 + 决策卡 + 受理卡 + 会话」，让老板频道有内容可渲染。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { SqliteDb } from '../db/open.js';
import type { ChatRepo } from './ports.js';

export function seedDemoData(db: SqliteDb, repo: ChatRepo): void {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM reports').get() as { n: number };
  if (existing.n > 0) return;

  const at = Date.now();
  const project = db
    .prepare(
      `INSERT INTO projects (name, alias, root_dir, created_at) VALUES (?, ?, ?, ?) RETURNING id`,
    )
    .get('记账系统', '记账', join(homedir(), '.aico', 'projects', 'bookkeeping'), at) as { id: number };

  const task = db
    .prepare(
      `INSERT INTO tasks (short_id, project_id, title, goal, acceptance, state, priority, risk_level, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      'T-1042',
      project.id,
      '竞品对账脚本调研与实现',
      '调研竞品对账脚本并实现',
      '[]',
      'executing',
      0,
      1,
      at - 3_600_000,
      at,
    ) as { id: number };

  const ask = db
    .prepare(
      `INSERT INTO reports (task_id, kind, payload, state, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      task.id,
      'ask',
      JSON.stringify({
        question: '对账脚本用 Python 还是 Node？',
        options: [
          { key: '1', label: 'Python', recommended: true },
          { key: '2', label: 'Node' },
        ],
        defaultAction: '1',
      }),
      'pending',
      at - 120_000,
    ) as { id: number };

  db.prepare(
    `INSERT INTO approvals (task_id, report_id, question, options, default_action, timeout_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    task.id,
    ask.id,
    '对账脚本用 Python 还是 Node？',
    JSON.stringify([
      { key: '1', label: 'Python', recommended: true },
      { key: '2', label: 'Node' },
    ]),
    '1',
    at + 4 * 3_600_000,
  );

  db.prepare(
    `INSERT INTO reports (task_id, kind, payload, state, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    task.id,
    'report',
    JSON.stringify({
      title: '已受理 · 竞品对账脚本调研与实现',
      tldr: '计划：拆成 3 步（调研 → 实现 → 验证）；风险 L1：计划评审后开工。',
    }),
    'acknowledged',
    at - 180_000,
  );

  repo.insertMessage({
    direction: 'out',
    taskId: task.id,
    content: '已受理 T-1042（记账系统）：竞品对账脚本调研与实现，计划 3 步。',
    now: at - 180_000,
  });
  repo.insertMessage({
    direction: 'in',
    taskId: task.id,
    content: '这两张表字段对不上，看下附件 📎',
    attachments: [{ name: 'diff.xlsx', size: 20480, type: 'application/vnd.ms-excel' }],
    now: at - 60_000,
  });
  repo.insertMessage({
    direction: 'out',
    taskId: task.id,
    content: '收到：两处字段不一致；已作为 T-1042 的输入产物，研究员在看。',
    now: at - 55_000,
  });

  // 左栏分组演示：再放几个不同 state 的任务（T0.6 验收②：ready → [data-testid=queue-item]）
  const extra: Array<{ short: string; title: string; state: string }> = [
    { short: 'T-1043', title: '官网首页改版', state: 'ready' },
    { short: 'T-1044', title: '数据平台接入', state: 'paused' },
    { short: 'T-1045', title: '周报模板整理', state: 'done' },
  ];
  for (const item of extra) {
    db.prepare(
      `INSERT INTO tasks (short_id, project_id, title, goal, acceptance, state, priority, risk_level, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(item.short, project.id, item.title, item.title, '[]', item.state, 0, 1, at - 60_000, at - 1_000);
  }
}
