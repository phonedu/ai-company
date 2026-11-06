/**
 * N5（`R3-3`）· 模型档位**纯逻辑**（`role_map` 词表 / 消毒 / 解析）——共享层（`src/core`），无 IO、无单例、无环境读取。
 *
 * 口径来源：
 *  - EMPLOYEES §10.3：项目里每个员工各用各的模型/供应商；critic/verifier 建议不同供应商（本项目暂单供应商，如实）；
 *  - `plan-m2-v2` N5 验收：**不动表** · 静态前缀字节一致 · **L0 用便宜档**；
 *  - `research-multi-agent-cost` §M3：贵模型想、便宜模型干；**仅 L0/L1 降级、L2 保留强模型**（本批只做 L0）。
 *
 * 分工：**真值注入**在 `agent/model-policy.ts`（设置项 `models.role_map` / `AICO_ECONOMY_MODEL` → 本模块纯函数）；
 * **写侧守卫**在 `db/settings.ts`（`models.role_map` 的 spec 复用本模块 `roleMapShapeError`，单一守卫防漂移）。
 */

/** 会话角色白名单（与四处会话点一一对应；不在此表的角色不得进 role_map——防悬空键）。 */
export const SESSION_ROLES = ['planner', 'critic', 'verifier', 'employee'] as const;
export type SessionRole = (typeof SESSION_ROLES)[number];

/** 思考强度（与 employees.thinking / SDK `ThinkingLevel` 同词表）。 */
export const THINKING_LEVELS = ['off', 'low', 'medium', 'high'] as const;
export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

export interface RoleMapEntry {
  model: string;
  thinking?: ThinkingLevelName;
}

export type RoleMap = Partial<Record<SessionRole, RoleMapEntry>>;

/** 档位来源（如实标注——"省了"与"没省"必须能一眼分开）。 */
export type ModelSource = 'task' | 'assistant' | 'employee' | 'role_map' | 'economy(L0)' | 'project_default' | 'default';

// ───────── D-22（2026-10-23）：项目模型策略（纯逻辑；写侧校验/解析共用）─────────

export const PROJECT_MODEL_POLICIES = ['fixed', 'employee_first', 'assistant'] as const;
export type ProjectModelPolicyName = (typeof PROJECT_MODEL_POLICIES)[number];

export interface ProjectModelPolicy {
  policy: ProjectModelPolicyName;
  /** 项目默认模型；`null`＝未设置（回落公司默认）。 */
  defaultModel: string | null;
  /** 模型级允许清单；空数组＝不额外限制（兼容旧项目）。 */
  allowedModels: readonly string[];
}

export function isProjectModelPolicyName(value: unknown): value is ProjectModelPolicyName {
  return typeof value === 'string' && (PROJECT_MODEL_POLICIES as readonly string[]).includes(value);
}

/** `allowed_models` 上限（防设置面失控；清单本来就该短）。 */
export const MAX_PROJECT_ALLOWED_MODELS = 32;

/**
 * D-22 写侧守卫（唯一判据）：返回人话 reason 或 `null`。
 * - `assistant` 需要模型目录（价格/上下文/能力标签）才能选型；目录未就绪 → **拒写**，不假装支持；
 * - 允许清单非空时，项目默认必须在清单内（硬约束）；
 * - 供应商白名单（旧列）非空时，清单/默认的供应商也必须在内（旧列继续有效）。
 */
export function projectModelPolicyError(input: {
  policy: unknown;
  defaultModel: unknown;
  allowedModels: unknown;
}, allowedProviders: readonly string[] = []): string | null {
  if (!isProjectModelPolicyName(input.policy)) {
    return `model_policy 需为 ${PROJECT_MODEL_POLICIES.join(' / ')}`;
  }
  let defaultModel: string | null = null;
  if (input.defaultModel !== null && input.defaultModel !== undefined) {
    if (typeof input.defaultModel !== 'string' || input.defaultModel.trim().length === 0) {
      return 'default_model 需为非空模型名，或 null（未设置）';
    }
    defaultModel = input.defaultModel.trim();
  }
  if (!Array.isArray(input.allowedModels)) return 'allowed_models 需为字符串数组';
  if (input.allowedModels.length > MAX_PROJECT_ALLOWED_MODELS) {
    return `allowed_models 最多 ${MAX_PROJECT_ALLOWED_MODELS} 个（收到 ${input.allowedModels.length} 个）`;
  }
  const allowed: string[] = [];
  for (const [i, item] of input.allowedModels.entries()) {
    if (typeof item !== 'string' || item.trim().length === 0) return `allowed_models 第 ${i + 1} 项需为非空模型名`;
    const model = item.trim();
    if (allowed.includes(model)) return `allowed_models 有重复项：${model}`;
    allowed.push(model);
  }
  if (input.policy === 'fixed' && defaultModel === null) {
    return 'fixed 策略必须设置 default_model（项目内只用一个模型）';
  }
  if (input.policy === 'assistant' && allowed.length === 0) {
    return 'assistant 策略必须设置 allowed_models（幕僚长只在允许清单内选）';
  }
  if (allowed.length > 0 && defaultModel === null) {
    return '设置了 allowed_models 就必须设置 default_model（清单外回落不能没有落点）';
  }
  if (allowed.length > 0 && defaultModel !== null && !allowed.includes(defaultModel)) {
    return `default_model「${defaultModel}」不在 allowed_models 内`;
  }
  if (allowedProviders.length > 0) {
    const outside = [...allowed, ...(defaultModel ? [defaultModel] : [])].find((m) => !allowedProviders.includes(providerOf(m)));
    if (outside) {
      return `模型「${outside}」的供应商不在项目供应商白名单（${allowedProviders.join(' / ')}）内`;
    }
  }
  return null;
}

export function isSessionRole(value: unknown): value is SessionRole {
  return typeof value === 'string' && (SESSION_ROLES as readonly string[]).includes(value);
}

export function isThinkingLevel(value: unknown): value is ThinkingLevelName {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value);
}

// ───────── N5 余账（2026-10-16）：兜底链 ＋ 供应商判据（纯逻辑；白名单/异供应商/运行时降级共用） ─────────

/** `models.fallback_chain` 上限（防失控；链路逐条真实调用）。 */
export const MAX_FALLBACK_CHAIN = 5;

/** `provider/model` → `provider`（无 `/` 整串视为供应商；白名单拦点/异供应商/兜底共用，禁抄二份）。 */
export function providerOf(model: string): string {
  const trimmed = model.trim();
  const slash = trimmed.indexOf('/');
  return slash > 0 ? trimmed.slice(0, slash) : trimmed;
}

/** `models.fallback_chain` 写侧形状校验（与 `roleMapShapeError` 同族：settings spec 复用同一判据）。 */
export function fallbackChainShapeError(value: unknown): string | null {
  if (!Array.isArray(value)) return '必须是字符串数组（模型名列表，如 ["deepseek/deepseek-flash"]）';
  if (value.length > MAX_FALLBACK_CHAIN) return `最多 ${MAX_FALLBACK_CHAIN} 条（收到 ${value.length} 条）`;
  for (const [i, item] of value.entries()) {
    if (typeof item !== 'string' || item.trim().length === 0) return `第 ${i + 1} 项必须是非空字符串`;
  }
  return null;
}

/** 读侧消毒：非法/重复/超限项**逐条留痕丢弃**（不静默）；`null`＝清空。 */
export function sanitizeFallbackChain(raw: unknown): { chain: string[]; dropped: string[] } {
  const dropped: string[] = [];
  if (raw == null) return { chain: [], dropped };
  if (!Array.isArray(raw)) return { chain: [], dropped: ['整体不是数组（丢弃）'] };
  const chain: string[] = [];
  for (const [i, item] of raw.entries()) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      dropped.push(`第 ${i + 1} 项非空串要求不满足`);
      continue;
    }
    const model = item.trim();
    if (chain.includes(model)) {
      dropped.push(`第 ${i + 1} 项重复（${model}）`);
      continue;
    }
    if (chain.length >= MAX_FALLBACK_CHAIN) {
      dropped.push(`第 ${i + 1} 项超出上限 ${MAX_FALLBACK_CHAIN}`);
      continue;
    }
    chain.push(model);
  }
  return { chain, dropped };
}

/**
 * 写侧形状守卫（唯一判据；`null`＝清空由调用方处理）——返回人话 reason 或 `null`（合法）。
 * 规则：值须为对象；键 ∈ SESSION_ROLES；每项 `{model: 非空串, thinking?: 四档}`；不得带未支持字段（防静默吞配置）。
 */
export function roleMapShapeError(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return '值需为对象（角色 → {model, thinking?}）';
  }
  for (const [role, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!isSessionRole(role)) return `未知角色「${role}」（可用：${SESSION_ROLES.join('/')}）`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return `角色「${role}」的值需为对象`;
    const e = entry as Record<string, unknown>;
    if (typeof e.model !== 'string' || e.model.trim().length === 0) return `角色「${role}」需非空 model`;
    if (e.thinking !== undefined && !isThinkingLevel(e.thinking)) {
      return `角色「${role}」的 thinking 需为 ${THINKING_LEVELS.join('/')}`;
    }
    const extra = Object.keys(e).filter((k) => k !== 'model' && k !== 'thinking');
    if (extra.length > 0) return `角色「${role}」含未支持字段：${extra.join('/')}`;
  }
  return null;
}

export interface SanitizeResult {
  map: RoleMap;
  /** 被丢弃项的**人话理由**（调用方负责留痕——不静默）。 */
  dropped: string[];
}

/**
 * 读边界防御性消毒（启动注入 / 设置写入 / 环境）：逐项丢非法并给理由，**不抛**。
 * 与 `roleMapShapeError` 同判据（单条非法只丢该条；整体非对象 ⇒ 全丢）。
 */
export function sanitizeRoleMap(value: unknown): SanitizeResult {
  // `null`/`undefined` ＝「未设置/清空」——**静默**（不是非法项，不刷告警）。
  if (value === null || value === undefined) return { map: {}, dropped: [] };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { map: {}, dropped: [`整体非对象：${JSON.stringify(value)}`] };
  }
  const map: RoleMap = {};
  const dropped: string[] = [];
  for (const [role, entry] of Object.entries(value as Record<string, unknown>)) {
    const reason = roleMapShapeError({ [role]: entry });
    if (reason !== null) {
      dropped.push(reason);
      continue;
    }
    const e = entry as { model: string; thinking?: ThinkingLevelName };
    map[role as SessionRole] = e.thinking === undefined ? { model: e.model.trim() } : { model: e.model.trim(), thinking: e.thinking };
  }
  return { map, dropped };
}

export interface ModelTierContext {
  /** 普通档（公司默认；设置 `models.default` → env 链解析后的值）。 */
  normalModel: string;
  /** 经济档（`AICO_ECONOMY_MODEL`）；未配置/与普通档相同 ⇒ **no-op**（不假装省了）。 */
  economyModel?: string | null;
  roleMap: RoleMap;
}

/** D-22 assistant 选型的候选（由主进程从模型目录投影；纯逻辑不读 SDK/文件）。 */
export interface AssistantCandidate {
  /** 规范引用 `provider/model`（目录口径）。 */
  model: string;
  contextWindow: number;
  reasoning: boolean;
  /** USD / 1M tokens。 */
  inputCost: number;
  outputCost: number;
}

export interface ModelTierInput {
  role: SessionRole;
  /** 任务风险档（0 直通 / 1 审计划 / 2 全流程）；**缺省不假设**（只把显式 0 当直通）。 */
  riskLevel?: number | null;
  /**
   * 任务级模型（`tasks.model`；009/N5 余账）——指派链**最高档**：任务级 > 员工级 > 角色映射 > 全局。
   * 显式人工指派 ⇒ 对该任务**全部会话角色**生效（含 planner/critic/verifier；明派压映射，不参与降档判定）。
   */
  taskModel?: string | null;
  /** 员工档案显式模型（`employees.model`；NULL＝跟随档位解析）。 */
  employeeModel?: string | null;
  /** 员工档案显式思考强度（`employees.thinking`）。 */
  employeeThinking?: string | null;
  /** D-22：项目模型策略（边界＋默认）；缺省＝旧行为（项目未配置）。 */
  project?: ProjectModelPolicy | null;
  /** D-22 assistant：项目允许清单内的模型目录候选；缺省/空＝按目录不可用回落。 */
  assistantCandidates?: readonly AssistantCandidate[] | null;
  /**
   * D-22 assistant LLM 自由裁量结果（主进程异步选出后缓存传入）；
   * 缺省/失败＝回落确定性规则。解析器仍会复核允许清单，越界结果不采信。
   */
  assistantChoice?: { model: string; reason: string } | null;
}

export interface ModelTierResolution {
  model: string;
  /** `null`＝不指定（不动会话缺省——不臆造档位）。 */
  thinking: ThinkingLevelName | null;
  source: ModelSource;
  /**
   * N5 余账（异供应商叠加）：`true`＝因"与实现者同供应商"而换到了兜底链中的异供应商模型；
   * `false`＝**应换但无第二供应商可用**（保持原模型，如实标注——调用方留痕）；`undefined`＝未尝试叠加。
   */
  diversified?: boolean;
  /** D-22：硬约束拒绝（任务模型不在项目允许清单 / assistant 未启用）；调用方须**响亮失败**，不静默改派。 */
  rejected?: string;
  /** D-22：发生了回落（如员工偏好不在允许清单）；`fallbackFrom` 是原优先来源。 */
  fallbackFrom?: ModelSource;
  fallbackReason?: string;
  /** assistant 选型理由（每次选择都记；其他来源为 undefined）。 */
  reason?: string;
}

function assistantAllowed(model: string, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return false;
  const slash = model.indexOf('/');
  const id = slash > 0 ? model.slice(slash + 1) : model;
  return allowed.includes(model) || allowed.includes(id);
}

/**
 * D-22 assistant 选型（确定规则，纯函数）：
 * - 规划/评审/L1+：优先 `reasoning` 与上下文（贵模型想）；
 * - 执行 + L0：优先成本（便宜模型干）；
 * - 员工显式偏好只作**同分时的建议**，不压过任务需求；
 * - 只从项目允许清单里选；无候选 → null（调用方回落并说明）。
 */
export function pickAssistantModel(input: {
  role: SessionRole;
  riskLevel?: number | null;
  employeeModel?: string | null;
  allowed: readonly string[];
  candidates: readonly AssistantCandidate[];
}): { model: string; reason: string } | null {
  const allowed = input.allowed;
  const candidates = input.candidates.filter((c) => assistantAllowed(c.model, allowed));
  if (candidates.length === 0) return null;
  const highNeed = input.role !== 'employee' || input.riskLevel == null || input.riskLevel >= 1;
  const preferred = typeof input.employeeModel === 'string' ? input.employeeModel.trim() : '';
  const score = (c: AssistantCandidate): number =>
    highNeed
      ? (c.reasoning ? 2 : 0) + Math.min(c.contextWindow / 200_000, 2) - c.outputCost / 100
      : -c.outputCost - c.inputCost / 10 + (c.reasoning ? 0.05 : 0);
  const sorted = [...candidates].sort((a, b) => {
    const diff = score(b) - score(a);
    if (Math.abs(diff) > 1e-9) return diff;
    const aPreferred = preferred.length > 0 && assistantAllowed(a.model, [preferred]) ? 1 : 0;
    const bPreferred = preferred.length > 0 && assistantAllowed(b.model, [preferred]) ? 1 : 0;
    if (aPreferred !== bPreferred) return bPreferred - aPreferred;
    if (a.outputCost !== b.outputCost) return a.outputCost - b.outputCost;
    return b.contextWindow - a.contextWindow;
  });
  const pick = sorted[0]!;
  const reason = highNeed
    ? `优先思考能力与上下文（${pick.reasoning ? '支持思考' : '不支持思考'}；上下文 ${pick.contextWindow}；输出 $${pick.outputCost}/1M）`
    : `L0 执行优先成本（输出 $${pick.outputCost}/1M；输入 $${pick.inputCost}/1M）`;
  return { model: pick.model, reason };
}

/**
 * 档位解析（唯一序）：**任务级 > 员工显式 > role_map > L0 经济档 > 普通档**。
 * - 降档**只对执行员工 + L0**；planner/critic/verifier 与 L1/L2 一律普通档（危险档不降）；
 * - 经济档未配置或与普通档同值 ⇒ 回落普通档且 `source='default'`（**如实**，不标 economy）。
 * - D-22 assistant：任务级 > (critic/verifier 角色映射) > 幕僚长选型 > 员工偏好建议 > 角色映射 > L0 > 项目默认 > 公司默认。
 */
export function resolveModelTier(input: ModelTierInput, ctx: ModelTierContext): ModelTierResolution {
  const employeeThinking = isThinkingLevel(input.employeeThinking) ? input.employeeThinking : null;
  const taskModel = typeof input.taskModel === 'string' && input.taskModel.trim().length > 0 ? input.taskModel.trim() : null;
  const project = input.project ?? null;
  const allowed = project?.allowedModels ?? [];
  const allowedSet = new Set(allowed);
  const isAllowed = (model: string): boolean => allowed.length === 0 || allowedSet.has(model);
  const projectDefault = project?.defaultModel ?? null;
  const defaultSource: ModelSource = projectDefault ? 'project_default' : 'default';
  const fallbackModel = projectDefault ?? ctx.normalModel;

  if (taskModel) {
    // 硬约束先过：任务级显式指定不在项目允许清单 → 直接拒（不静默回落）。
    if (!isAllowed(taskModel)) {
      return {
        model: taskModel,
        thinking: employeeThinking,
        source: 'task',
        rejected: `任务模型「${taskModel}」不在项目允许清单内（允许：${allowed.join(' / ')}）`,
      };
    }
    return { model: taskModel, thinking: employeeThinking, source: 'task' };
  }

  // D-22 assistant：幕僚长在允许清单内按任务选；critic/verifier 的角色映射优先（视角差异）。
  if (project?.policy === 'assistant') {
    const entry = ctx.roleMap[input.role];
    if ((input.role === 'critic' || input.role === 'verifier') && entry && isAllowed(entry.model)) {
      return { model: entry.model, thinking: employeeThinking ?? entry.thinking ?? null, source: 'role_map' };
    }
    // LLM 幕僚长选择：只采信允许清单内的结果；越界/空理由不采信（回落规则，下轮重试）。
    const choice = input.assistantChoice;
    if (choice && choice.model.trim().length > 0 && isAllowed(choice.model.trim())) {
      return {
        model: choice.model.trim(),
        thinking: employeeThinking,
        source: 'assistant',
        reason: `幕僚长：${choice.reason.trim() || '按任务上下文选择'}`,
      };
    }
    const picked = pickAssistantModel({
      role: input.role,
      riskLevel: input.riskLevel,
      employeeModel: input.employeeModel,
      allowed,
      candidates: input.assistantCandidates ?? [],
    });
    if (picked) {
      return { model: picked.model, thinking: employeeThinking, source: 'assistant', reason: picked.reason };
    }
    return {
      model: fallbackModel,
      thinking: employeeThinking,
      source: defaultSource,
      fallbackFrom: 'assistant',
      fallbackReason: `允许清单内没有可用的模型目录项，已回落${projectDefault ? '项目默认' : '公司默认'}`,
    };
  }

  // fixed：项目内只用一个模型；员工偏好与角色映射都压到项目默认。
  if (project?.policy === 'fixed') {
    return {
      model: projectDefault ?? ctx.normalModel,
      thinking: employeeThinking,
      source: defaultSource,
    };
  }

  const employeeModel = typeof input.employeeModel === 'string' && input.employeeModel.trim().length > 0 ? input.employeeModel.trim() : null;
  if (employeeModel) {
    if (!isAllowed(employeeModel)) {
      // 员工偏好不在允许清单 → 回落项目默认（docs/08 §10.5 规则 5），并说明原因。
      return {
        model: fallbackModel,
        thinking: employeeThinking,
        source: defaultSource,
        fallbackFrom: 'employee',
        fallbackReason: `员工偏好「${employeeModel}」不在项目允许清单内，已回落${projectDefault ? '项目默认' : '公司默认'}`,
      };
    }
    return { model: employeeModel, thinking: employeeThinking, source: 'employee' };
  }
  const entry = ctx.roleMap[input.role];
  if (entry) {
    if (isAllowed(entry.model)) {
      return { model: entry.model, thinking: employeeThinking ?? entry.thinking ?? null, source: 'role_map' };
    }
    // 角色映射不在允许清单 → 继续往下走；最终结果带回落说明（不静默）。
    const economy = typeof ctx.economyModel === 'string' && ctx.economyModel.trim().length > 0 ? ctx.economyModel.trim() : null;
    if (input.role === 'employee' && input.riskLevel === 0 && economy !== null && economy !== ctx.normalModel && isAllowed(economy)) {
      return {
        model: economy,
        thinking: employeeThinking,
        source: 'economy(L0)',
        fallbackFrom: 'role_map',
        fallbackReason: `角色映射「${entry.model}」不在项目允许清单内，已回落省钱档`,
      };
    }
    return {
      model: fallbackModel,
      thinking: employeeThinking,
      source: defaultSource,
      fallbackFrom: 'role_map',
      fallbackReason: `角色映射「${entry.model}」不在项目允许清单内，已回落${projectDefault ? '项目默认' : '公司默认'}`,
    };
  }
  const economy = typeof ctx.economyModel === 'string' && ctx.economyModel.trim().length > 0 ? ctx.economyModel.trim() : null;
  if (input.role === 'employee' && input.riskLevel === 0 && economy !== null && economy !== ctx.normalModel) {
    if (isAllowed(economy)) {
      return { model: economy, thinking: employeeThinking, source: 'economy(L0)' };
    }
    return {
      model: fallbackModel,
      thinking: employeeThinking,
      source: defaultSource,
      fallbackFrom: 'economy(L0)',
      fallbackReason: `省钱档「${economy}」不在项目允许清单内，已回落${projectDefault ? '项目默认' : '公司默认'}`,
    };
  }
  return { model: fallbackModel, thinking: employeeThinking, source: defaultSource };
}

/**
 * D-22 选择期 Key 硬校验：模型选定后再核一次「供应商 Key 是否可用」。
 *
 * 口径：
 *  - 任务显式模型 Key 不可用 → **直接拒**（与越界同等硬约束，不静默改派）；
 *  - 员工偏好/角色映射/assistant 的 Key 不可用 → 回落项目默认并留 `fallbackFrom`；
 *  - 项目默认/公司默认本身 Key 不可用 → 拒（没有更低的合法档）。
 * 目录里 `keyConfigured=false` 的模型已在候选阶段滤掉；本函数兜住显式指派与目录外模型。
 */
export function applyModelKeyGate(
  tier: ModelTierResolution,
  options: {
    project?: ProjectModelPolicy | null;
    /** 公司默认模型（项目未设默认时的回落落点；缺省不回落）。 */
    companyDefault?: string | null;
    keyConfigured: (model: string) => boolean;
  },
): ModelTierResolution {
  if (tier.rejected) return tier;
  if (options.keyConfigured(tier.model)) return tier;
  const projectDefault = options.project?.defaultModel ?? null;
  const companyDefault = options.companyDefault ?? null;
  const allowed = options.project?.allowedModels ?? [];
  const allowedOk = (model: string): boolean => allowed.length === 0 || allowed.includes(model);
  const canFallback =
    tier.source === 'employee' ||
    tier.source === 'role_map' ||
    tier.source === 'assistant' ||
    tier.source === 'economy(L0)';
  if (canFallback) {
    const candidates: Array<{ model: string; source: 'project_default' | 'default' }> = [];
    if (projectDefault) candidates.push({ model: projectDefault, source: 'project_default' });
    if (companyDefault) candidates.push({ model: companyDefault, source: 'default' });
    const hit = candidates.find(
      (c) => c.model !== tier.model && allowedOk(c.model) && options.keyConfigured(c.model),
    );
    if (hit) {
      return {
        ...tier,
        model: hit.model,
        source: hit.source,
        fallbackFrom: tier.source,
        fallbackReason: `模型「${tier.model}」的供应商未配置 API Key，已回落${hit.source === 'project_default' ? '项目默认' : '公司默认'}「${hit.model}」`,
        reason: undefined,
      };
    }
  }
  return {
    ...tier,
    rejected: `模型「${tier.model}」的供应商未配置 API Key（D-22：Key 不可用同样拦截；请在设置 → 模型与供应商配置 Key）`,
  };
}
