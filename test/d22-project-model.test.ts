/**
 *  项目模型策略（2026-10-23）——数据层与解析器的可执行锚。
 *
 * 判据：
 *   ① 迁移 v18 三列默认值（旧项目 = employee_first / 无默认 / 无清单）；
 *   ② 写侧守卫：assistant 暂不启用、清单/默认/供应商白名单互相约束、非法拒且不落库；
 *   ③ 解析优先级：任务 > 员工（仅允许清单内）> 项目默认；fixed 压平；越界任务模型直接拒；
 *   ④ IPC 返回更新后的 ProjectDTO（读面仍走 project:get，零新读通道）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { applyModelKeyGate, projectModelPolicyError, resolveModelTier } from '../src/core/model-tiers.js';
import { openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import { getProjectModelPolicy, setProjectModelPolicy } from '../src/main/db/projects.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { handleProjectDefaultBudgetSet, handleProjectGet, handleProjectModelPolicySet, handleTaskCreate, handleTaskGet } from '../src/main/ipc/ipc.js';

const AT = 1_800_000_000_000;

function setup(projectOverrides: { allowedProviders?: string[] } = {}) {
  const db = openMemoryDatabase();
  runMigrations(db);
  db.prepare(
    `INSERT INTO projects (id, name, root_dir, allowed_providers, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(11, '记账系统', 'D:/repo/a', JSON.stringify(projectOverrides.allowedProviders ?? []), AT);
  const repo = createSqliteChatRepo(db);
  return { db, repo, deps: { repo } };
}

const CTX = { normalModel: 'deepseek/deepseek-flash', economyModel: null, roleMap: {} };

test('迁移 v18：旧项目默认 employee_first / 无默认模型 / 空允许清单（不臆造）', () => {
  const { db } = setup();
  const row = db
    .prepare('SELECT default_model, allowed_models, model_policy FROM projects WHERE id = 11')
    .get() as { default_model: string | null; allowed_models: string; model_policy: string };
  assert.equal(row.default_model, null);
  assert.equal(row.allowed_models, '[]');
  assert.equal(row.model_policy, 'employee_first');
  assert.deepEqual(getProjectModelPolicy(db, 11), {
    policy: 'employee_first',
    defaultModel: null,
    allowedModels: [],
  });
  db.close();
});

test('写侧守卫：assistant 必须有允许清单；fixed 必须有默认；清单必须有默认且默认在清单内；供应商白名单继续生效', () => {
  assert.match(projectModelPolicyError({ policy: 'assistant', defaultModel: null, allowedModels: [] }) ?? '', /allowed_models/);
  assert.equal(
    projectModelPolicyError({
      policy: 'assistant',
      defaultModel: 'deepseek/deepseek-flash',
      allowedModels: ['deepseek/deepseek-flash', 'deepseek/deepseek-v4-pro'],
    }),
    null,
    'assistant 目录就绪后可写（有允许清单＋默认回落）',
  );
  assert.match(
    projectModelPolicyError({ policy: 'fixed', defaultModel: null, allowedModels: [] }) ?? '',
    /必须设置 default_model/,
  );
  assert.match(
    projectModelPolicyError({
      policy: 'employee_first',
      defaultModel: null,
      allowedModels: ['deepseek/deepseek-flash'],
    }) ?? '',
    /必须设置 default_model/,
  );
  assert.match(
    projectModelPolicyError({
      policy: 'employee_first',
      defaultModel: 'deepseek/deepseek-flash',
      allowedModels: ['xiaomi/mimo-v2.6-flash'],
    }) ?? '',
    /不在 allowed_models/,
  );
  assert.match(
    projectModelPolicyError({
      policy: 'employee_first',
      defaultModel: 'deepseek/deepseek-flash',
      allowedModels: ['deepseek/deepseek-flash', 'deepseek/deepseek-flash'],
    }) ?? '',
    /重复/,
  );
  assert.match(
    projectModelPolicyError(
      {
        policy: 'employee_first',
        defaultModel: 'openai/gpt-5',
        allowedModels: ['openai/gpt-5'],
      },
      ['deepseek'],
    ) ?? '',
    /供应商不在项目供应商白名单/,
  );
  assert.equal(
    projectModelPolicyError({
      policy: 'employee_first',
      defaultModel: 'deepseek/deepseek-flash',
      allowedModels: ['deepseek/deepseek-flash', 'xiaomi/mimo-v2.6-flash'],
    }),
    null,
  );
});

test('DAO/IPC：合法策略落库并回 DTO；非法策略不落库', () => {
  const { db, deps } = setup({ allowedProviders: ['deepseek', 'xiaomi'] });
  const bad = handleProjectModelPolicySet(deps, {
    projectId: 11,
    policy: 'assistant',
    defaultModel: null,
    allowedModels: [],
  }) as { ok: false; code: string; message: string };
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'bad_value');
  assert.match(bad.message, /allowed_models/);
  assert.equal(
    (db.prepare('SELECT model_policy FROM projects WHERE id = 11').get() as { model_policy: string }).model_policy,
    'employee_first',
    '被拒的值绝不落库',
  );

  const ok = handleProjectModelPolicySet(deps, {
    projectId: 11,
    policy: 'fixed',
    defaultModel: 'deepseek/deepseek-v4-pro',
    allowedModels: ['deepseek/deepseek-v4-pro', 'xiaomi/mimo-v2.6-flash'],
  }) as { ok: true; project: { modelPolicy: string; defaultModel: string; allowedModels: string[] } };
  assert.equal(ok.ok, true);
  assert.equal(ok.project.modelPolicy, 'fixed');
  assert.equal(ok.project.defaultModel, 'deepseek/deepseek-v4-pro');
  assert.deepEqual(ok.project.allowedModels, ['deepseek/deepseek-v4-pro', 'xiaomi/mimo-v2.6-flash']);

  const dto = handleProjectGet(deps, { projectId: 11 });
  assert.equal(dto?.modelPolicy, 'fixed');
  assert.equal(dto?.defaultModel, 'deepseek/deepseek-v4-pro');
  assert.deepEqual(dto?.allowedModels, ['deepseek/deepseek-v4-pro', 'xiaomi/mimo-v2.6-flash']);

  const missing = handleProjectModelPolicySet(deps, { projectId: 999, policy: 'employee_first', defaultModel: null, allowedModels: [] });
  assert.equal((missing as { ok: false; code: string }).code, 'not_found');
  db.close();
});

test('解析器：无项目策略＝旧行为；employee_first 用允许清单内的员工偏好，越界回落项目默认并说明原因', () => {
  assert.equal(
    resolveModelTier({ role: 'employee', employeeModel: 'xiaomi/mimo-v2.6-flash' }, CTX).source,
    'employee',
  );

  const project = {
    policy: 'employee_first' as const,
    defaultModel: 'deepseek/deepseek-v4-pro',
    allowedModels: ['deepseek/deepseek-v4-pro', 'xiaomi/mimo-v2.6-flash'],
  };
  const allowed = resolveModelTier({ role: 'employee', employeeModel: 'xiaomi/mimo-v2.6-flash', project }, CTX);
  assert.equal(allowed.model, 'xiaomi/mimo-v2.6-flash');
  assert.equal(allowed.source, 'employee');

  const fallback = resolveModelTier({ role: 'employee', employeeModel: 'openai/gpt-5', project }, CTX);
  assert.equal(fallback.model, 'deepseek/deepseek-v4-pro');
  assert.equal(fallback.source, 'project_default');
  assert.equal(fallback.fallbackFrom, 'employee');
  assert.match(fallback.fallbackReason ?? '', /不在项目允许清单内/);

  const noPref = resolveModelTier({ role: 'employee', project }, CTX);
  assert.equal(noPref.model, 'deepseek/deepseek-v4-pro');
  assert.equal(noPref.source, 'project_default');
});

test('任务详情读面：modelResolution 随 task:get 返回（执行员工视角；fixed 走项目默认）', () => {
  const { db, deps } = setup();
  setProjectModelPolicy(db, {
    projectId: 11,
    policy: 'fixed',
    defaultModel: 'deepseek/deepseek-v4-pro',
    allowedModels: ['deepseek/deepseek-v4-pro'],
  });
  db.prepare(
    `INSERT INTO tasks(id, short_id, project_id, title, goal, acceptance, state, risk_level, priority, created_at, updated_at)
     VALUES(1, 'T-1001', 11, '演示任务', 'g', '[]', 'ready', 1, 0, ?, ?)`,
  ).run(AT, AT);
  const detail = handleTaskGet(deps, { taskId: 1 });
  assert.equal(detail?.modelResolution.model, 'deepseek/deepseek-v4-pro');
  assert.equal(detail?.modelResolution.source, 'project_default');
  assert.equal(detail?.task.model, null, '任务未显式指派');
  db.close();
});

test('解析器：fixed 压平员工偏好；任务模型越界直接拒（硬约束）', () => {
  const fixed = {
    policy: 'fixed' as const,
    defaultModel: 'deepseek/deepseek-v4-pro',
    allowedModels: ['deepseek/deepseek-v4-pro'],
  };
  const forced = resolveModelTier(
    { role: 'employee', employeeModel: 'xiaomi/mimo-v2.6-flash', project: fixed },
    CTX,
  );
  assert.equal(forced.model, 'deepseek/deepseek-v4-pro');
  assert.equal(forced.source, 'project_default');

  const taskAllowed = resolveModelTier({ role: 'employee', taskModel: 'deepseek/deepseek-v4-pro', project: fixed }, CTX);
  assert.equal(taskAllowed.source, 'task');
  const taskRejected = resolveModelTier({ role: 'employee', taskModel: 'xiaomi/mimo-v2.6-flash', project: fixed }, CTX);
  assert.equal(taskRejected.source, 'task');
  assert.match(taskRejected.rejected ?? '', /不在项目允许清单内/);

});

test('建任务前置拒绝：任务模型不在项目允许清单 → 不落库、human 原因', async () => {
  const { db, deps } = setup();
  setProjectModelPolicy(db, {
    projectId: 11,
    policy: 'employee_first',
    defaultModel: 'deepseek/deepseek-flash',
    allowedModels: ['deepseek/deepseek-flash'],
  });
  await assert.rejects(
    () => handleTaskCreate(deps, { projectId: 11, title: '坏模型', goal: 'g', model: 'xiaomi/mimo-v2.6-flash' }),
    /不在项目允许清单内/,
  );
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n, 0, '被拒任务不落库');

  const ok = await handleTaskCreate(deps, {
    projectId: 11,
    title: '允许模型',
    goal: 'g',
    model: 'deepseek/deepseek-flash',
  });
  assert.equal(ok.model, 'deepseek/deepseek-flash');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n, 1);
  db.close();
});

test('解析器 assistant：高风险选思考模型，L0 选便宜模型；无目录候选回落项目默认并说明', () => {
  const project = {
    policy: 'assistant' as const,
    defaultModel: 'deepseek/deepseek-flash',
    allowedModels: ['deepseek/deepseek-flash', 'deepseek/deepseek-v4-pro'],
  };
  const candidates = [
    { model: 'deepseek/deepseek-flash', contextWindow: 1_000_000, reasoning: false, inputCost: 0.3, outputCost: 1.2 },
    { model: 'deepseek/deepseek-v4-pro', contextWindow: 1_000_000, reasoning: true, inputCost: 1.32, outputCost: 3.96 },
  ];
  const high = resolveModelTier({ role: 'planner', riskLevel: 2, project, assistantCandidates: candidates }, CTX);
  assert.equal(high.source, 'assistant');
  assert.equal(high.model, 'deepseek/deepseek-v4-pro', '高风险优先思考能力');
  assert.match(high.reason ?? '', /思考/);

  const low = resolveModelTier(
    {
      role: 'employee',
      riskLevel: 0,
      project,
      assistantCandidates: candidates,
      employeeModel: 'deepseek/deepseek-v4-pro', // 员工偏好只作建议，不压 L0 成本
    },
    CTX,
  );
  assert.equal(low.source, 'assistant');
  assert.equal(low.model, 'deepseek/deepseek-flash', 'L0 优先成本');
  assert.match(low.reason ?? '', /成本/);

  const noCatalog = resolveModelTier({ role: 'employee', project, assistantCandidates: [] }, CTX);
  assert.equal(noCatalog.source, 'project_default');
  assert.equal(noCatalog.fallbackFrom, 'assistant');
  assert.match(noCatalog.fallbackReason ?? '', /目录项/);
});

test('选择期 Key 硬校验：任务显式缺 Key 直接拒；员工偏好缺 Key 回落项目默认并留原因；默认缺 Key 也拒', () => {
  const project = {
    policy: 'employee_first' as const,
    defaultModel: 'deepseek/deepseek-flash',
    allowedModels: ['deepseek/deepseek-flash', 'xiaomi/mimo-v2.6-flash'],
  };
  const keyed = (model: string): boolean => model === 'deepseek/deepseek-flash';

  const taskTier = resolveModelTier({ role: 'employee', taskModel: 'xiaomi/mimo-v2.6-flash', project }, CTX);
  const taskBlocked = applyModelKeyGate(taskTier, { project, keyConfigured: keyed });
  assert.equal(taskBlocked.source, 'task');
  assert.match(taskBlocked.rejected ?? '', /未配置 API Key/, '任务显式模型缺 Key → 硬拒（不改派）');

  const employeeTier = resolveModelTier({ role: 'employee', employeeModel: 'xiaomi/mimo-v2.6-flash', project }, CTX);
  const fallback = applyModelKeyGate(employeeTier, { project, keyConfigured: keyed });
  assert.equal(fallback.model, 'deepseek/deepseek-flash');
  assert.equal(fallback.source, 'project_default');
  assert.equal(fallback.fallbackFrom, 'employee');
  assert.match(fallback.fallbackReason ?? '', /未配置 API Key/);
  assert.equal(fallback.rejected, undefined);

  const defaultTier = resolveModelTier({ role: 'planner', project }, CTX);
  const defaultBlocked = applyModelKeyGate(defaultTier, { project, keyConfigured: () => false });
  assert.match(defaultBlocked.rejected ?? '', /未配置 API Key/, '项目默认本身缺 Key → 拒');
});

test('解析器 assistant：LLM 选择在允许清单内优先于规则；越界选择不采信、回落规则', () => {
  const project = {
    policy: 'assistant' as const,
    defaultModel: 'deepseek/deepseek-flash',
    allowedModels: ['deepseek/deepseek-flash', 'deepseek/deepseek-v4-pro'],
  };
  const candidates = [
    { model: 'deepseek/deepseek-flash', contextWindow: 1_000_000, reasoning: false, inputCost: 0.3, outputCost: 1.2 },
    { model: 'deepseek/deepseek-v4-pro', contextWindow: 1_000_000, reasoning: true, inputCost: 1.32, outputCost: 3.96 },
  ];
  const llm = resolveModelTier(
    {
      role: 'employee',
      riskLevel: 0,
      project,
      assistantCandidates: candidates,
      assistantChoice: { model: 'deepseek/deepseek-v4-pro', reason: '这次要改动核心模块' },
    },
    CTX,
  );
  assert.equal(llm.model, 'deepseek/deepseek-v4-pro');
  assert.equal(llm.source, 'assistant');
  assert.match(llm.reason ?? '', /幕僚长：这次要改动核心模块/);

  const outOfList = resolveModelTier(
    {
      role: 'employee',
      riskLevel: 0,
      project,
      assistantCandidates: candidates,
      assistantChoice: { model: 'openai/gpt-5', reason: '越界' },
    },
    CTX,
  );
  assert.equal(outOfList.model, 'deepseek/deepseek-flash', '越界选择不采信 → 规则选 L0 便宜档');
  assert.equal(outOfList.source, 'assistant');
  assert.match(outOfList.reason ?? '', /成本/);
});

test('Key 硬校验：无项目默认时回落公司默认；经济档缺 Key 回落项目默认', () => {
  const keyed = (model: string): boolean => model === 'deepseek/deepseek-flash';
  const employee = resolveModelTier({ role: 'employee', employeeModel: 'xiaomi/mimo-v2.6-flash' }, CTX);
  const toCompany = applyModelKeyGate(employee, { project: null, companyDefault: 'deepseek/deepseek-flash', keyConfigured: keyed });
  assert.equal(toCompany.model, 'deepseek/deepseek-flash');
  assert.equal(toCompany.source, 'default');
  assert.equal(toCompany.fallbackFrom, 'employee');
  assert.match(toCompany.fallbackReason ?? '', /公司默认/);

  const economy = {
    model: 'xiaomi/mimo-v2.6-flash',
    thinking: null,
    source: 'economy(L0)' as const,
  };
  const project = {
    policy: 'employee_first' as const,
    defaultModel: 'deepseek/deepseek-flash',
    allowedModels: ['deepseek/deepseek-flash', 'xiaomi/mimo-v2.6-flash'],
  };
  const toProject = applyModelKeyGate(economy, { project, companyDefault: 'deepseek/deepseek-flash', keyConfigured: keyed });
  assert.equal(toProject.model, 'deepseek/deepseek-flash');
  assert.equal(toProject.source, 'project_default');
  assert.equal(toProject.fallbackFrom, 'economy(L0)');

  // 任务显式缺 Key 不回落（即使公司默认可用）
  const taskBlocked = applyModelKeyGate(
    { model: 'xiaomi/mimo-v2.6-flash', thinking: null, source: 'task' },
    { project: null, companyDefault: 'deepseek/deepseek-flash', keyConfigured: keyed },
  );
  assert.match(taskBlocked.rejected ?? '', /未配置 API Key/);

  // 公司默认不在项目允许清单 → 不得作为回落目标
  const notAllowed = applyModelKeyGate(employee, {
    project: {
      policy: 'employee_first',
      defaultModel: 'xiaomi/mimo-v2.6-flash',
      allowedModels: ['xiaomi/mimo-v2.6-flash'],
    },
    companyDefault: 'deepseek/deepseek-flash',
    keyConfigured: keyed,
  });
  assert.match(notAllowed.rejected ?? '', /未配置 API Key/);
});

test('v19 项目默认任务预算：新建任务未填预算时继承；显式预算优先；非法拒', async () => {
  const { db, deps } = setup();
  try {
    const saved = handleProjectDefaultBudgetSet(deps, { projectId: 11, budgetTokens: 500 }) as {
      ok: true;
      project: { defaultBudgetTokens: number | null };
    };
    assert.equal(saved.ok, true);
    assert.equal(saved.project.defaultBudgetTokens, 500);

    const inherited = await handleTaskCreate(deps, { projectId: 11, title: '继承预算', goal: 'g' });
    assert.equal(inherited.budgetTokens, 500, '未显式给预算 → 继承项目默认');
    const explicit = await handleTaskCreate(deps, { projectId: 11, title: '显式预算', goal: 'g', budgetTokens: 120 });
    assert.equal(explicit.budgetTokens, 120, '任务显式预算优先');

    const bad = handleProjectDefaultBudgetSet(deps, { projectId: 11, budgetTokens: 0 }) as { ok: false; code: string };
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'bad_value');
    await assert.rejects(
      () => handleTaskCreate(deps, { projectId: 11, title: '非法预算', goal: 'g', budgetTokens: 0 }),
      /需为正整数/,
      '显式非法预算必须拒，不静默继承',
    );
  } finally {
    db.close();
  }
});
