/**
 * N5（`R3-3`）· 模型分层 ＋ 默认省钱档（`models.role_map` 落实现）——守据。
 *
 * 口径来源：
 *  - 08 §10.3：项目里**每个员工各用各的模型/供应商**；critic/verifier 建议不同供应商（本项目暂单供应商，如实）；
 *  - `plan-m2-v2` N5 验收：**不动表**（role_map 走设置项 JSON，不加表/列）· 静态前缀字节一致（缓存前提）· **L0 用便宜档**；
 *  - `research-multi-agent-cost` §M3：贵模型想、便宜模型干；**仅 L0/L1 降级，L2 保留强模型**（本批只做 L0，最小且可验）。
 *
 * 覆盖：解析优先级（员工显式 > role_map > L0 经济档 > 普通档）· 经济档未配置＝no-op（**不假装省了**）·
 * role_map 形状校验（角色白名单/逐项形状，拒后不落库）· 静态前缀字节一致 · 接线守卫（执行器传档/运行时逐轮应用/
 * 设置读写注入）· 有牙（换档真发生、L2 不降、守卫正则能弄红）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getFallbackChain, getRoleMap, isProviderUnavailableError, providerForModel, resolveSessionModel, setFallbackChain, setRoleMap } from '../src/main/agent/model-policy.js';
import { isKnownSettingKey, validateSettingValue } from '../src/main/db/settings.js';
import { fallbackChainShapeError, sanitizeFallbackChain } from '../src/core/model-tiers.js';
import { openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import { insertEmployee } from '../src/main/db/employees.js';
import { buildEmployeeContext } from '../src/main/agent/context.js';

/** 每个用例都从干净态开始（模块级单例：role_map/经济档是全局注入，测试间必须复位）。 */
function withCleanPolicy(env: { economy?: string; normal?: string }): () => void {
  const beforeEco = process.env.AICO_ECONOMY_MODEL;
  const beforeNormal = process.env.AICO_MODEL;
  setRoleMap(null);
  if (env.economy === undefined) delete process.env.AICO_ECONOMY_MODEL;
  else process.env.AICO_ECONOMY_MODEL = env.economy;
  if (env.normal === undefined) delete process.env.AICO_MODEL;
  else process.env.AICO_MODEL = env.normal;
  return () => {
    setRoleMap(null);
    if (beforeEco === undefined) delete process.env.AICO_ECONOMY_MODEL;
    else process.env.AICO_ECONOMY_MODEL = beforeEco;
    if (beforeNormal === undefined) delete process.env.AICO_MODEL;
    else process.env.AICO_MODEL = beforeNormal;
  };
}

test('N5 档位: 员工显式模型 > role_map > L0 经济档 > 普通档（逐级回落，逐级可辨）', () => {
  const restore = withCleanPolicy({ economy: 'eco-1', normal: 'strong-1' });
  try {
    // ⓪ 任务级模型（009，N5 余账）＝链顶：压过员工显式/role_map/经济档；对所有角色生效
    setRoleMap({ employee: { model: 'role-1' } });
    assert.deepEqual(
      resolveSessionModel({ role: 'employee', riskLevel: 0, taskModel: 'task-1', employeeModel: 'emp-1' }),
      { model: 'task-1', thinking: null, source: 'task' },
    );
    assert.deepEqual(
      resolveSessionModel({ role: 'verifier', riskLevel: 2, taskModel: 'task-1' }),
      { model: 'task-1', thinking: null, source: 'task' },
      '明派对评审角色同样生效（明派压映射）',
    );
    assert.deepEqual(
      resolveSessionModel({ role: 'employee', riskLevel: 0, taskModel: '   ' }),
      { model: 'role-1', thinking: null, source: 'role_map' },
      '空白任务级模型视为未指派（回既有链，不臆造）',
    );
    // ① 员工档案显式（最具体）——压过 role_map 与经济档
    assert.deepEqual(
      resolveSessionModel({ role: 'employee', riskLevel: 0, employeeModel: 'emp-1' }),
      { model: 'emp-1', thinking: null, source: 'employee' },
    );
    // ② role_map 命中（次具体）——压过 L0 经济档
    assert.deepEqual(
      resolveSessionModel({ role: 'employee', riskLevel: 0 }),
      { model: 'role-1', thinking: null, source: 'role_map' },
    );
    // ③ 无 role_map ⇒ L0 执行员工走经济档
    setRoleMap(null);
    assert.deepEqual(
      resolveSessionModel({ role: 'employee', riskLevel: 0 }),
      { model: 'eco-1', thinking: null, source: 'economy(L0)' },
    );
    // ④ 规划/验收/评审**不降**（施工图 §2.10②：执行员工省钱档、规划/验收强档）
    for (const role of ['planner', 'critic', 'verifier'] as const) {
      assert.deepEqual(
        resolveSessionModel({ role, riskLevel: 0 }),
        { model: 'strong-1', thinking: null, source: 'default' },
        `${role} 不得走省钱档`,
      );
    }
  } finally {
    restore();
  }
});

test('N5 档位: 经济档未配置＝no-op（不假装省了）；L1/L2 保留强档（危险档不降）', () => {
  const restore = withCleanPolicy({ normal: 'strong-2' }); // 不设 AICO_ECONOMY_MODEL
  try {
    assert.deepEqual(
      resolveSessionModel({ role: 'employee', riskLevel: 0 }),
      { model: 'strong-2', thinking: null, source: 'default' },
      '未配省钱档 ⇒ 如实回落普通档（source 不得标 economy）',
    );
  } finally {
    restore();
  }

  const restore2 = withCleanPolicy({ economy: 'eco-3', normal: 'strong-3' });
  try {
    for (const riskLevel of [1, 2, null, undefined] as const) {
      const r = resolveSessionModel({ role: 'employee', riskLevel });
      assert.equal(r.model, 'strong-3', `riskLevel=${String(riskLevel)} 不得降档`);
      assert.equal(r.source, 'default');
    }
  } finally {
    restore2();
  }
});

test('N5 档位: 思考强度——员工显式 > role_map 项 > 不指定（null＝不动会话缺省）', () => {
  const restore = withCleanPolicy({ normal: 'strong-4' });
  try {
    setRoleMap({ critic: { model: 'critic-m', thinking: 'high' } });
    assert.deepEqual(resolveSessionModel({ role: 'critic', riskLevel: 2 }), { model: 'critic-m', thinking: 'high', source: 'role_map' });
    assert.deepEqual(
      resolveSessionModel({ role: 'critic', riskLevel: 2, employeeThinking: 'low' }),
      { model: 'critic-m', thinking: 'low', source: 'role_map' },
      '员工档案显式思考强度 > role_map 项',
    );
    assert.equal(resolveSessionModel({ role: 'employee', riskLevel: 2 }).thinking, null, '都没设 ⇒ null（不臆造档位）');
  } finally {
    restore();
  }
});

test('N5 role_map: 注入时消毒（非法项丢弃并留痕，合法项保留；null 清空）', () => {
  const restore = withCleanPolicy({});
  try {
    const warnings: string[] = [];
    setRoleMap(null);
    setRoleMap(undefined); // 清空/未设置＝静默（不算非法项）
    const orig = console.warn;
    console.warn = (m?: unknown) => warnings.push(String(m));
    try {
      setRoleMap({
        employee: { model: 'ok-1' },
        critic: { model: '' }, // 空 model ⇒ 丢
        verifier: 123, // 非对象 ⇒ 丢
        planner: { model: 'ok-2', thinking: 'high' },
        boss: { model: 'x' }, // 未知角色 ⇒ 丢
      } as never);
    } finally {
      console.warn = orig;
    }
    assert.deepEqual(getRoleMap(), { employee: { model: 'ok-1' }, planner: { model: 'ok-2', thinking: 'high' } });
    assert.equal(warnings.length, 3, '三项非法必须留痕（不静默）；null/undefined 清空**不**在此列');
    setRoleMap(null);
    assert.deepEqual(getRoleMap(), {});
  } finally {
    restore();
  }
});

test('N5 设置: `models.role_map` 入白名单；形状校验拒非法（拒后不落库＝写侧唯一守卫）', () => {
  assert.ok(isKnownSettingKey('models.role_map'), '键必须在白名单（否则设置页写不进、也不许有悬空键）');
  // 合法：空表 / 单角色 / 带 thinking / provider/model 形式
  for (const ok of [{}, { employee: { model: 'deepseek-flash' } }, { critic: { model: 'a/b', thinking: 'high' } }]) {
    assert.deepEqual(validateSettingValue('models.role_map', ok), { ok: true }, JSON.stringify(ok));
  }
  // 非法：数组 / 非对象 / 未知角色 / 空 model / 坏 thinking / 值非对象
  const bad: unknown[] = [
    [],
    'x',
    { boss: { model: 'x' } },
    { employee: { model: '' } },
    { employee: { model: 'x', thinking: 'huge' } },
    { employee: { model: 7 } },
  ];
  for (const v of bad) {
    const r = validateSettingValue('models.role_map', v);
    assert.equal(r.ok, false, `必须拒：${JSON.stringify(v)}`);
  }
  assert.deepEqual(validateSettingValue('models.role_map', null), { ok: true }, 'null＝清空，恒合法');
});

test('N5 缓存前提: 同一状态连build两次 → system/user 段**字节一致**（静态前缀可复用）', () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  insertEmployee(db, { id: 5, name: '钱', role: 'engineer', persona: '写短句', now: 1 });
  db.prepare('INSERT INTO projects (id, name, root_dir, created_at) VALUES (?, ?, ?, ?)').run(1, 'p', 'D:\\w', 1);
  db.prepare(
    'INSERT INTO tasks (id, short_id, title, goal, acceptance, state, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(1, 'T-1', '题', '目标', JSON.stringify(['验收甲']), 'executing', 1, 1, 1);
  const a = buildEmployeeContext(db, { employeeId: 5, taskId: 1, bossText: '原话' });
  const b = buildEmployeeContext(db, { employeeId: 5, taskId: 1, bossText: '原话' });
  assert.equal(a.systemPrompt, b.systemPrompt, 'system 段必须逐字节一致（否则缓存前缀永久打掉）');
  assert.equal(a.userPrompt, b.userPrompt);
  db.close();
});

test('N5 接线: 执行器四处会话都解析档位并传参（防"实现了不接线"）', () => {
  const ex = readFileSync(join(process.cwd(), 'src', 'main', 'agent', 'employee-executor.ts'), 'utf8');
  const hits = ex.match(/resolveSessionModel\(/g) ?? [];
  assert.ok(hits.length >= 3, `四处会话点（critic+verifier 合一）必须都解析档位，实测 ${hits.length} 处`);
  assert.ok(/model:\s*tier\.model/.test(ex), '解析结果必须进 run 入参（model）');
  assert.ok(/thinkingLevel:\s*tier\.thinking/.test(ex), '思考强度必须随行（只发显式值）');
  const rt = readFileSync(join(process.cwd(), 'src', 'main', 'agent', 'pi-runtime.ts'), 'utf8');
  assert.ok(/session\.setModel\(|\.setModel\(/.test(rt), '运行时必须逐轮应用档位（setModel）');
  assert.ok(/persist:\s*false/.test(rt), 'setModel 必须 session-only（不得写全局默认）');
  const ipc = readFileSync(join(process.cwd(), 'src', 'main', 'ipc', 'ipc.ts'), 'utf8');
  assert.ok(/setRoleMap\(/.test(ipc), 'settings:set 必须把 models.role_map 注入策略（写入即生效下次装配）');
  const idx = readFileSync(join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8');
  assert.ok(/setRoleMap\(/.test(idx), '启动必须注入 role_map（否则重启后档位丢失）');
});

test('N5 "有牙": 换档真发生（前后值不同）＋ 守卫正则能弄红', () => {
  const restore = withCleanPolicy({ economy: 'eco-x', normal: 'strong-x' });
  try {
    const l0 = resolveSessionModel({ role: 'employee', riskLevel: 0 });
    const l2 = resolveSessionModel({ role: 'employee', riskLevel: 2 });
    assert.notEqual(l0.model, l2.model, 'L0 与 L2 必须落到不同模型（否则"省钱"没发生）');
    assert.equal(l0.model, 'eco-x');
    assert.equal(l2.model, 'strong-x');
  } finally {
    restore();
  }
  // 守卫正则的负例：不含 setModel 的旧实现不匹配
  const broken = 'await session.prompt(input.prompt); // 无 setModel';
  assert.ok(!/\.setModel\(/.test(broken));
  assert.ok(!/persist:\s*false/.test(broken));
});

// ───────── N5 余账（2026-10-16）：兜底链配置 ＋ critic/verifier 异供应商 ＋ 错误分类 ─────────

test('N5 余账: `models.fallback_chain` —— 写侧拒非法／读侧逐条消毒／设置键入白名单', () => {
  assert.equal(fallbackChainShapeError(['deepseek/deepseek-flash']), null);
  assert.match(fallbackChainShapeError('nope') ?? '', /字符串数组/);
  assert.match(fallbackChainShapeError(Array.from({ length: 6 }, (_, i) => `m/${i}`)) ?? '', /最多 5 条/);
  assert.match(fallbackChainShapeError(['ok/x', 1]) ?? '', /第 2 项/);

  const s = sanitizeFallbackChain(['a/1', 'a/1', '  ', 'b/2', 'c/3', 'd/4', 'e/5']);
  assert.deepEqual(s.chain, ['a/1', 'b/2', 'c/3', 'd/4', 'e/5'], '重复/空白/超限逐条丢，合法项保序');
  assert.equal(s.dropped.length, 2, '丢弃逐条留痕（不静默）：重复＋空白各一（第 5 条恰在限内）');
  assert.deepEqual(sanitizeFallbackChain(null).chain, [], 'null＝清空');

  assert.equal(isKnownSettingKey('models.fallback_chain'), true);
  assert.equal(validateSettingValue('models.fallback_chain', ['deepseek/x']).ok, true);
  assert.equal(validateSettingValue('models.fallback_chain', 'nope').ok, false, '写侧守卫拒非法（拒后不落库）');
});

test('N5 余账: 异供应商叠加 —— critic/verifier 与实现者同供应商时取兜底链中的异供应商；无第二供应商如实标 false；明派不叠加', () => {
  const restore = withCleanPolicy({ normal: 'deepseek/strong' });
  try {
    setFallbackChain(['deepseek/alt', 'anthropic/claude-x']);
    // 裸模型名的 peer（deepseek-flash）也要归一到 deepseek，不能整串当供应商
    setFallbackChain(['xiaomi/mimo-v2.6-flash']);
    assert.equal(
      resolveSessionModel({ role: 'critic', peerProvider: 'deepseek-flash' }, { keyAvailable: () => true }).model,
      'xiaomi/mimo-v2.6-flash',
      '裸 peer 名必须先归一化再比供应商',
    );
    setFallbackChain(['deepseek/alt', 'anthropic/claude-x']);
    // 评审默认档落在 deepseek（=实现者供应商）→ 取链中首个异供应商
    assert.deepEqual(resolveSessionModel({ role: 'critic', peerProvider: 'deepseek' }, { keyAvailable: () => true }), {
      model: 'anthropic/claude-x',
      thinking: null,
      source: 'default',
      diversified: true,
    });
    // 备选存在但缺 Key → 保持原模型并如实标 false（不得把评审整单拒掉）
    const blocked = resolveSessionModel({ role: 'critic', peerProvider: 'deepseek' }, { keyAvailable: () => false });
    assert.equal(blocked.model, 'deepseek/strong');
    assert.equal(blocked.diversified, false);
    // 链里全是同供应商 → 保持 + diversified:false（如实，调用方留痕）
    setFallbackChain(['deepseek/other']);
    assert.equal(resolveSessionModel({ role: 'verifier', peerProvider: 'deepseek' }, { keyAvailable: () => true }).diversified, false);
    // 明派（任务级）压一切 → 不尝试叠加（undefined）
    setFallbackChain(['anthropic/claude-x']);
    assert.equal(
      resolveSessionModel({ role: 'verifier', peerProvider: 'deepseek', taskModel: 'deepseek/x' }).diversified,
      undefined,
    );
    // 不同供应商/未给 peer → 不叠加
    assert.equal(resolveSessionModel({ role: 'critic', peerProvider: 'anthropic' }).diversified, undefined);
    assert.equal(resolveSessionModel({ role: 'critic' }).diversified, undefined);
  } finally {
    setFallbackChain(null);
    restore();
  }
});

test('N5 余账: 兜底链错误分类 —— 供应商不可用命中（401/429/5xx/模型不存在/连接层）；普通错误不误判', () => {
  assert.equal(isProviderUnavailableError('HTTP 401 Unauthorized'), true);
  assert.equal(isProviderUnavailableError('429 rate limit exceeded'), true);
  assert.equal(isProviderUnavailableError('invalid api key'), true);
  assert.equal(isProviderUnavailableError('model deepseek/foo not found'), true);
  assert.equal(isProviderUnavailableError('[agent] 模型不存在：deepseek/nonexistent-c1（档位解析给的模型不可用）'), true);
  assert.equal(isProviderUnavailableError('模型不可用：模型已下线'), true);
  assert.equal(isProviderUnavailableError('缺少 deepseek 凭据：未找到 env DEEPSEEK_API_KEY'), false, '无凭据走 C8，不当降级');
  assert.equal(isProviderUnavailableError('fetch failed'), true);
  assert.equal(isProviderUnavailableError('ECONNREFUSED 127.0.0.1:443'), true);
  assert.equal(isProviderUnavailableError('内部断言失败：证据不足'), false, '真 bug 不拖去换模型重跑');
  assert.deepEqual(getFallbackChain(), [], '清空后为 []（不残留）');
});

test('D-22 Key 映射：带前缀按前缀；裸名先 AICO_PROVIDER，再目录，最后前缀', () => {
  assert.equal(providerForModel('claude-x', [], 'anthropic'), 'anthropic', '裸名 + AICO_PROVIDER');
  assert.equal(
    providerForModel('claude-x', [{ provider: 'anthropic', id: 'claude-x' }], 'openai'),
    'openai',
    '裸名优先 AICO_PROVIDER（与运行期装配一致）',
  );
  assert.equal(
    providerForModel('deepseek-flash', [{ provider: 'deepseek', id: 'deepseek-flash' }], 'my-deepseek'),
    'my-deepseek',
    'env provider 覆盖裸名目录命中',
  );
  assert.equal(providerForModel('deepseek-flash', [], undefined), 'deepseek', '已知前缀仍可映射');
  assert.equal(providerForModel('deepseek/deepseek-flash', [], 'xiaomi'), 'deepseek', '带前缀不服从 env');
});
