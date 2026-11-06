import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

import { appendMemory, buildProjectMemoryBrief, insertTaskEvent, insertWorkItem, openMemoryDatabase, replacePlanSteps, runMigrations } from '../src/main/db/index.js';
import { insertEmployee } from '../src/main/db/employees.js';
import { buildEmployeeContext, buildReviewContext, personaLayer, PLATFORM_LAYER, roleLayer } from '../src/main/agent/context.js';

// ── OPT-AI-1：员工上下文组装（简版五层，分段可辨识；只读） ──

test('AI-1 context: 五层分段 + 元数据（platform/role/persona/baseline/task）', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  insertEmployee(db, { id: 3, name: '林悦', role: 'engineer', persona: '偏好小步提交', now: 1 });
  db.prepare(
    "INSERT INTO projects (id, name, root_dir, created_at) VALUES (?, ?, ?, ?)",
  ).run(11, 'proj', 'D:\\work\\proj', 1);
  db.prepare(
    "INSERT INTO tasks (id, short_id, title, goal, acceptance, state, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(1, 'T-1001', '修渲染', '让 tab 正确', JSON.stringify(['产物行数==查询数', '空态不伪装']), 'executing', 11, 1, 1);

  const ctx = buildEmployeeContext(db, { employeeId: 3, taskId: 1, bossText: '把产物 tab 收一下' });
  assert.ok(ctx.systemPrompt.includes(PLATFORM_LAYER));
  assert.ok(ctx.systemPrompt.includes('[角色规则]') && ctx.systemPrompt.includes('engineer'));
  assert.ok(ctx.systemPrompt.includes('[员工人设]') && ctx.systemPrompt.includes('偏好小步提交'));
  // N4（OPT-AI-4）：任务基线（含验收/简报/证据索引）在 **system 段** ⇒ 压缩后仍在（构造性保证）。
  assert.ok(ctx.systemPrompt.includes('[任务基线]'), 'system 段必须有任务基线段');
  assert.ok(ctx.systemPrompt.includes('验收标准：产物行数==查询数；空态不伪装'), '验收标准必须进 system 段（压缩不丢）');
  assert.ok(ctx.systemPrompt.includes('任务：修渲染；目标：让 tab 正确'));
  assert.ok(ctx.systemPrompt.includes('证据索引：'), '证据索引行必须在（无产物 → 占位）');
  assert.ok(ctx.userPrompt.includes('【老板原话】把产物 tab 收一下'));
  assert.ok(ctx.userPrompt.includes('【项目上下文】'));
  // N4 回归守卫：简报/验收**不得**留在 user 段（user 段会被压缩吞掉）。
  assert.ok(!ctx.userPrompt.includes('【任务简报】'), '简报不得留在 user 段（会被压缩）');
  assert.ok(!ctx.userPrompt.includes('验收标准'), '验收标准不得留在 user 段（会被压缩）');
  assert.deepEqual(ctx.meta.layers, { platform: true, role: true, persona: true, memory: false, memoryBrief: false, facts: false, skills: false, retrieval: false, fewShot: true, baseline: true, planRecitation: true, project: false, task: true });
  assert.equal(ctx.meta.projectRoot, 'D:\\work\\proj');
  assert.equal(ctx.meta.cwd, 'D:\\work\\proj');
  db.close();
});

test('AI-1 context: 人设为空 → 仍留可辨识占位（层 false）；无任务 → 基线占位不臆造', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  insertEmployee(db, { id: 7, name: '无名', role: 'writer', now: 1 });
  const ctx = buildEmployeeContext(db, { employeeId: 7, taskId: 999 });
  assert.ok(ctx.systemPrompt.includes('[员工人设] （未设置）'));
  assert.equal(ctx.meta.layers.persona, false);
  assert.equal(ctx.meta.layers.task, false);
  assert.equal(ctx.meta.layers.baseline, false, '无任务 → 无真实基线（占位不当真）');
  assert.ok(ctx.systemPrompt.includes('[任务基线]') && ctx.systemPrompt.includes('验收标准：—'), '基线占位用 — 不臆造');
  assert.equal(roleLayer(''), roleLayer('  ')); // 稳定
  assert.ok(personaLayer('').startsWith('[员工人设]'));
  db.close();
});

test('G11 context: 员工记忆进 system 段（真实记忆 → memory:true；无 → 占位 + false，绝不臆造）', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  insertEmployee(db, { id: 3, name: '林悦', role: 'engineer', persona: '偏好小步提交', now: 1 });
  db.prepare('INSERT INTO projects (id, name, root_dir, created_at) VALUES (?, ?, ?, ?)').run(11, 'proj', 'D:\\work\\proj', 1);
  db.prepare(
    'INSERT INTO tasks (id, short_id, title, goal, acceptance, state, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(1, 'T-1001', '修渲染', '让 tab 正确', JSON.stringify(['产物行数==查询数']), 'executing', 11, 1, 1);

  const before = buildEmployeeContext(db, { employeeId: 3, taskId: 1 });
  assert.ok(before.systemPrompt.includes('[员工记忆]（跨任务，只读）'), '记忆段必须在场（占位不臆造）');
  assert.ok(before.systemPrompt.includes('[项目记忆简报]（最近任务索引）'), '短简报段必须在场（占位不臆造）');
  assert.ok(before.systemPrompt.includes('（暂无）'), '无记忆 → 占位「（暂无）」');
  assert.equal(before.meta.layers.memory, false, '无真实记忆 → false（不当真）');
  assert.equal(before.meta.layers.memoryBrief, false, '无真实记忆 → 简报 false');

  appendMemory(db, {
    employeeId: 3,
    projectId: 11,
    block: '[任务 T-0999] 上一件（2026-10-13 完成）\n验收：跑通',
    marker: '[任务 T-0999]',
    now: 2,
  });
  const after = buildEmployeeContext(db, { employeeId: 3, taskId: 1 });
  assert.ok(after.systemPrompt.includes('[任务 T-0999] 上一件'), '真实记忆必须进 system 段');
  assert.equal(after.meta.layers.memory, true);
  assert.equal(after.meta.layers.memoryBrief, true, '有真实记忆 → 简报 true');
  assert.ok(after.systemPrompt.includes('[项目记忆简报]（最近任务索引）\n[任务 T-0999] 上一件'), '简报列最近任务首行');
  // 静态→动态：记忆层在任务基线之前（护缓存前缀）
  assert.ok(
    after.systemPrompt.indexOf('[员工记忆]') < after.systemPrompt.indexOf('[任务基线]'),
    '记忆层必须在任务基线之前（静态→动态）',
  );
  db.close();
});

test('V3 修：critic 材料必须含「被评审计划」（plan_steps）——否则 L1 结构上到不了 awaiting_approval', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  insertEmployee(db, { id: 3, name: '林悦', role: 'engineer', now: 1 });
  db.prepare('INSERT INTO projects (id, name, root_dir, created_at) VALUES (?, ?, ?, ?)').run(11, 'proj', 'D:\\work\\proj', 1);
  db.prepare(
    'INSERT INTO tasks (id, short_id, title, goal, acceptance, state, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(1, 'T-1001', '修渲染', '让 tab 正确', JSON.stringify(['产物行数==查询数']), 'planning', 11, 1, 1);
  // idx 是 1 基（与 replacePlanSteps 投影一致）
  db.prepare('INSERT INTO plan_steps (task_id, idx, text, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(1, 1, '第一步：读代码定位', 'pending', 1, 1);

  const ctx = buildReviewContext(db, { role: 'critic', taskId: 1, reviewerEmployeeId: 3, bossText: null });
  assert.ok(ctx.userPrompt.includes('【被评审计划（plan_steps）】'), 'critic 材料必须有「被评审计划」段（V3 修）');
  assert.ok(ctx.userPrompt.includes('1. [pending] 第一步：读代码定位'), '计划步骤（序号/状态/文本）必须进材料');
  assert.equal(ctx.userPrompt.includes('（无计划步骤'), false, '有步骤时不得出现「无计划步骤」占位（有牙）');

  // 有牙反向：无步骤时如实占位（不假造计划）
  db.prepare('DELETE FROM plan_steps WHERE task_id = 1').run();
  const empty = buildReviewContext(db, { role: 'critic', taskId: 1, reviewerEmployeeId: 3, bossText: null });
  assert.ok(empty.userPrompt.includes('（无计划步骤'), '无计划时必须如实占位');
  db.close();
});

test('F-02：verifier 材料必须含计划步骤状态＋planStepsNote 交代口径（未完成不是硬门）', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  insertEmployee(db, { id: 3, name: '林悦', role: 'reviewer', now: 1 });
  db.prepare('INSERT INTO projects (id, name, root_dir, created_at) VALUES (?, ?, ?, ?)').run(11, 'proj', 'D:\\work\\proj', 1);
  db.prepare(
    'INSERT INTO tasks (id, short_id, title, goal, acceptance, state, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(1, 'T-1001', '修渲染', '让 tab 正确', JSON.stringify(['产物行数==查询数']), 'verifying', 11, 1, 1);
  db.prepare('INSERT INTO plan_steps (task_id, idx, text, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(1, 1, '第一步：搭底座', 'done', 1, 1);
  db.prepare('INSERT INTO plan_steps (task_id, idx, text, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(1, 2, '第二步：补文档', 'pending', 1, 1);
  const wi = insertWorkItem(db, { taskId: 1, employeeId: 3, title: 'w', brief: 'b', now: 1 });
  db.prepare('UPDATE work_items SET result = ? WHERE id = ?').run(JSON.stringify('产出：测试全过'), wi.id);

  const ctx = buildReviewContext(db, { role: 'verifier', taskId: 1, reviewerEmployeeId: 3, workItemId: wi.id });
  assert.ok(ctx.userPrompt.includes('【计划步骤（1/2 已关）】'), 'verifier 必须看到计划完成度（F-02 根因）');
  assert.ok(ctx.userPrompt.includes('1. [done] 第一步：搭底座'), '已关步骤也要列出（可核对）');
  assert.ok(ctx.userPrompt.includes('2. [pending] 第二步：补文档'), '未完成步骤必须可见');
  assert.ok(ctx.userPrompt.includes('planStepsNote'), '必须说明用 submit_review.planStepsNote 交代');
  assert.ok(ctx.userPrompt.includes('不是硬门'), '口径必须写清：不要求全部 done');
  db.close();
});

test('N5 尾项：项目记忆短简报最多 5 行、单行 ≤100 字（防它自己变成上下文债）', () => {
  const blocks = Array.from({ length: 8 }, (_, i) => {
    const short = `[任务 T-${1000 + i}] 第 ${i} 件`;
    return `${short}${'长'.repeat(120)}（日期）\n验收：x`;
  }).join('\n\n');
  const brief = buildProjectMemoryBrief(blocks);
  const lines = brief.split('\n');
  assert.equal(lines.length, 5, '最多列 5 件');
  assert.ok(lines.every((line) => line.length <= 100), '每行截断到 100 字');
  assert.match(brief, /T-1007/, '保留最近一件');
  assert.doesNotMatch(brief, /T-1000\]/, '最旧的被挤出');
  assert.equal(buildProjectMemoryBrief(''), '（暂无）', '无记忆 → 占位（不臆造）');
});

test('交付纪律：员工工作项上下文必须有「必须 submit_work_item」硬约束；规划/评审不注入', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  insertEmployee(db, { id: 3, name: '林悦', role: 'engineer', now: 1 });
  db.prepare("INSERT INTO projects (id, name, root_dir, created_at) VALUES (11, 'proj', 'D:/work/proj', 1)").run();
  db.prepare(
    "INSERT INTO tasks (id, short_id, title, goal, acceptance, state, project_id, created_at, updated_at) VALUES (1, 'T-1001', '算一下', '15×3', '[]', 'executing', 11, 1, 1)",
  ).run();
  const wi = insertWorkItem(db, { taskId: 1, employeeId: 3, title: '算一下', brief: '15×3', now: 2 });
  const withWi = buildEmployeeContext(db, { employeeId: 3, taskId: 1, workItemId: wi.id });
  assert.ok(withWi.systemPrompt.includes('[交付纪律]'), '工作项必须有交付纪律层');
  assert.match(withWi.systemPrompt, /submit_work_item/);
  assert.match(withWi.userPrompt, /【交付要求】[\s\S]*submit_work_item/, 'user prompt 末尾必须再提醒提交');
  assert.match(withWi.systemPrompt.trimEnd(), /不要用聊天式回答代替提交。$/, '交付纪律在 system 段最后一行（离生成最近）');
  const withoutWi = buildEmployeeContext(db, { employeeId: 3, taskId: 1 });
  assert.equal(withoutWi.systemPrompt.includes('[交付纪律]'), false, '无工作项（规划/评审/闲聊）不注入');
  db.close();
});

// ── CTX-1 P2 · CTX1-6 计划复述（user 段；评审不复述） ──

test('CTX1-6: user 段带计划复述（进行中/下一步/验收/剩余预算/最近失败），评审会话不带', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  insertEmployee(db, { id: 3, name: '林悦', role: 'engineer', now: 1 });
  insertEmployee(db, { id: 8, name: '评审', role: 'critic', now: 1 });
  db.prepare('INSERT INTO projects (id, name, root_dir, created_at) VALUES (?, ?, ?, ?)').run(11, 'proj', 'D:\work\proj', 1);
  db.prepare(
    'INSERT INTO tasks (id, short_id, title, goal, acceptance, state, project_id, budget_tokens, cost_tokens, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(1, 'T-1001', '交付对账单', '整理 PDF', JSON.stringify(['PDF 有 10 月数据', '合计一致']), 'executing', 11, 50000, 12000, 1, 1);
  replacePlanSteps(db, 1, ['整理数据', '生成 PDF', '自检'], 1);
  db.prepare("UPDATE plan_steps SET state='done' WHERE task_id=1 AND idx=1").run();
  db.prepare("UPDATE plan_steps SET state='running' WHERE task_id=1 AND idx=2").run();
  insertTaskEvent(db, { taskId: 1, workItemId: null, ts: 2, kind: 'revise', actor: 'boss', payload: { notes: '合计对不上' } });

  const ctx = buildEmployeeContext(db, { employeeId: 3, taskId: 1, bossText: '开始' });
  assert.match(ctx.userPrompt, /【当前计划复述】进度 1\/3/);
  assert.match(ctx.userPrompt, /进行中：2\. 生成 PDF/);
  assert.match(ctx.userPrompt, /下一步：3\. 自检/);
  assert.match(ctx.userPrompt, /验收摘要：PDF 有 10 月数据；合计一致/);
  assert.match(ctx.userPrompt, /剩余预算：38000 tokens（已用 12000\/50000）/);
  assert.match(ctx.userPrompt, /最近失败\/打回：revise：合计对不上/);
  assert.equal(ctx.meta.layers.planRecitation, true);
  assert.ok(ctx.meta.telemetry?.layers.some((l) => l.name === 'planRecitation' && l.side === 'user'));

  const review = buildReviewContext(db, {
    role: 'critic',
    taskId: 1,
    workItemId: null,
    reviewerEmployeeId: 8,
  });
  assert.equal(review.userPrompt.includes('【当前计划复述】'), false, '评审材料已含计划，不重复复述');
  assert.equal(review.meta.layers.planRecitation, false);

  // 无计划/无验收/无预算/无事件 → 不注入空段
  db.prepare(
    'INSERT INTO tasks (id, short_id, title, goal, acceptance, state, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(2, 'T-1002', '空任务', 'g', '[]', 'inbox', 11, 1, 1);
  const bare = buildEmployeeContext(db, { employeeId: 3, taskId: 2 });
  assert.equal(bare.userPrompt.includes('【当前计划复述】'), false);
  assert.equal(bare.meta.layers.planRecitation, false);
  db.close();
});

// ── RET-1 P1：项目约定截断给路径/目录；L1 记忆有预算 ──

test('RET-F-01: 项目约定超限 → 标记带 read 路径＋章节目录（中段规则可按需读）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aico-ret1-'));
  try {
    mkdirSync(join(dir, '.aico'), { recursive: true });
    const agents = ['# 硬约束', '- 必须遵守 A', '# 门禁', '- 命令 B', '# 交付', '- 规则 C']
      .concat(Array.from({ length: 600 }, (_, i) => `- 补充规则 ${i}：不要静默丢内容，报告要可核查。`))
      .join('\n');
    writeFileSync(join(dir, 'AGENTS.md'), agents, 'utf8');
    const db = openMemoryDatabase();
    runMigrations(db);
    insertEmployee(db, { id: 3, name: '林悦', role: 'engineer', now: 1 });
    db.prepare('INSERT INTO projects (id, name, root_dir, created_at) VALUES (?, ?, ?, ?)').run(11, 'proj', dir, 1);
    db.prepare(
      'INSERT INTO tasks (id, short_id, title, goal, acceptance, state, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(1, 'T-1001', '任务', 'g', '[]', 'executing', 11, 1, 1);
    const ctx = buildEmployeeContext(db, { employeeId: 3, taskId: 1, bossText: '开始' });
    const layer = ctx.meta.telemetry?.layers.find((l) => l.name === 'projectContext');
    assert.equal(layer?.truncated, true);
    assert.match(ctx.userPrompt, /read AGENTS\.md/, '截断标记必须给文件路径');
    assert.match(ctx.userPrompt, /【projectContext 章节目录】/, '必须给被截断章节的目录');
    assert.match(ctx.userPrompt, /# 硬约束/);
    assert.match(ctx.userPrompt, /# 门禁/);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('RET-F-02: L1 记忆有 cap（近期保留＋显式标记），不再整本灌', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  insertEmployee(db, { id: 3, name: '林悦', role: 'engineer', now: 1 });
  db.prepare('INSERT INTO projects (id, name, root_dir, created_at) VALUES (?, ?, ?, ?)').run(11, 'proj', 'D:\work\proj', 1);
  db.prepare(
    'INSERT INTO tasks (id, short_id, title, goal, acceptance, state, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(1, 'T-1001', '任务', 'g', '[]', 'executing', 11, 1, 1);
  for (let i = 0; i < 20; i += 1) {
    appendMemory(db, {
      employeeId: 3,
      projectId: 11,
      block: `任务 T-${2000 + i} · 第 ${i} 条历史\n${'很长的历史细节。'.repeat(200)}`,
      marker: `T-${2000 + i}`,
      now: 1 + i,
    });
  }
  const ctx = buildEmployeeContext(db, { employeeId: 3, taskId: 1 });
  const layer = ctx.meta.telemetry?.layers.find((l) => l.name === 'memory');
  assert.equal(layer?.truncated, true, 'L1 记忆超 1200 估计 token 必须截断');
  assert.ok((layer?.tokensBeforeCap ?? 0) > 1200);
  assert.match(ctx.systemPrompt, /【memory 已截断/);
  assert.match(ctx.systemPrompt, /T-2019/, '近期记忆（最后一条）必须保留');
  assert.equal(ctx.meta.layers.memory, true, '有真实记忆仍记 true');
  db.close();
});
