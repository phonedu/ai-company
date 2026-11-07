import { DATA_NOT_INSTRUCTION, wrapExternalData } from './data-boundary.js';
/**
 * OPT-AI-1 · 员工上下文组装（`BuildEmployeeContext` 的实现）。
 *
 * 口径（2285①；**N4 调整**；**G11 追加记忆层**）：**简版分层**，但**在代码里必须是可辨识的分段**（不压成一段拼字符串）：
 *   系统提示词 = ①平台底座 + ②角色规则 + ③`employees.persona` + **记忆层（G11，跨任务只读）** + **④任务基线（简报/验收/证据索引）**；
 *   首条 user prompt = 老板原话 + ⑤项目上下文（`.aico/CONTEXT.md`，存在则读、缺失不报错）。
 *
 * **N4 为什么把「任务基线」移进 system（`OPT-AI-4`）**：底座的自动压缩（threshold/overflow）**不传 customInstructions**
 * ⇒ 我们无法给摘要注入领域指令；而 **system 段不参与历史压缩** ⇒ 基线（**验收标准**必须有）**压缩后必然仍在**——
 * **构造性保证**，不靠"希望摘要保留"。压缩本身仍由底座生成（我们只观测、不改变行为）。
 * **只读**：不写库、不读任务工作区以外的文件。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getProjectById, getSkillByName, getTaskById, getWorkItem, listArtifactsByTask, listPlanSteps, listTaskEvents, readMemory, buildProjectMemoryBrief, readSetting, resolveEnabledMcpServers, resolveEnabledSkills, searchRelated, type RetrievalHit, type SkillRow } from '../db/index.js';
import { fewShotEnabled, fewShotLayer } from './prompt-templates.js';
import { MEMORY_DATA_BOUNDARY, SqliteMemoryStore, renderBrief, type Principal } from '../memory/index.js';
import { buildTelemetry, capLayer, extendTelemetry, LAYER_TOKEN_CAPS } from './context-telemetry.js';
import { latestSetbackText } from './compaction-handoff.js';
import { isCtxEnabled } from './context-flags.js';
import { isRepoMapEnabled } from './repo-map.js';
import { isDocsCheckAcceptance } from '../docs/contract.js';
import type { SqliteDb } from '../db/open.js';
import type { EmployeeContext, EmployeeContextInput } from './types.js';

/** ① 平台底座（对所有员工相同）。 */
export const PLATFORM_LAYER =
  '[平台底座] ai-company：老板是唯一决策者；产出必须可核查、失败必须留痕；不确定就如实说明，绝不编造。' +
  MEMORY_DATA_BOUNDARY;

/**
 * 工作项交付纪律（只注入**员工工作项**上下文，规划/评审不注入）：
 * 2026-10-17 MiMo 验收实测——模型把工作项当聊天题，直接回「15×3=45」而不调 `submit_work_item`，
 * 宿主按 `agent_settled{submitted:false}` 判失败。工具描述已有要求，但**模型不一定读**；这里把
 * 「不提交=失败」写成硬约束（任何模型同一口径）。
 */
export const REPO_MAP_HINT_LAYER =
  '[仓库地图] 需要定位代码/文件时，先调用 repo_map（按文件名或符号查询），再决定 read/grep；不要一上来就全仓 find/grep。';

export const DELIVERY_DISCIPLINE_LAYER =
  '[交付纪律] 你现在是**执行员工**（不是规划者/评审者）；计划已批准（L0 为直通），直接按计划执行，**不要复述计划、不要等指令**。本工作项必须以 `submit_work_item` 提交结构化结果（summary 必填；产物/证据按实际给）。只回复文字、不调用提交工具 = 本轮失败（宿主会判 failed）；不要用聊天式回答代替提交。' +
  // B2-7（58 §2.5 G6；D-30）：git 写操作归宿主——员工自行 commit/push 会被权限层拒绝。
  '不自行执行 git commit/push 等版本库写操作（权限层会拒绝）；代码提交由宿主在验收通过后统一完成，你只用只读 git（status/log/diff/show/branch）查看现场。';

/** ② 角色规则（按 `employees.role`）。 */
export function roleLayer(role: string): string {
  const r = role.trim().length > 0 ? role.trim() : '员工';
  return `[角色规则] 你是「${r}」。遵守项目约定与验收标准；只做被派发的工作项；不要越权。`;
}

/** ③ 员工人设（`employees.persona`；为空也要留可辨识占位，防以后补全时重写）。 */
export function personaLayer(persona: string): string {
  return `[员工人设] ${persona.trim().length > 0 ? persona.trim() : '（未设置）'}`;
}

/**
 * 记忆层（G11 / 施工图 R2-1）：跨任务长期记忆（`employee_memory`，项目分区；只读）。
 * 位置＝人设之后、任务基线之前（**静态→动态**排序，护缓存前缀）；system 段 ⇒ 压缩后仍在。
 * 无记忆 → 占位「（暂无）」（不臆造；`meta.layers.memory` 记"有无真实记忆"）。
 */
export function memoryLayer(text: string): string {
  return `[员工记忆]（跨任务，只读）\n${text.trim().length > 0 ? text.trim() : '（暂无）'}`;
}

/**
 * N5 尾项（项目记忆短简报）：完整记忆块之前的一页索引——最近 N 件任务的首行（任务号＋标题＋日期）。
 * **确定性投影**（不调 LLM）；长度由 `buildProjectMemoryBrief` 上限约束（最多 5 行、每行 100 字）。
 */
export function projectMemoryBriefLayer(brief: string): string {
  return `[项目记忆简报]（最近任务索引）\n${brief.trim().length > 0 ? brief.trim() : '（暂无）'}`;
}

function parseRefList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((v): v is string | number => typeof v === 'string' || typeof v === 'number').map(String);
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string | number => typeof v === 'string' || typeof v === 'number').map(String)
      : [];
  } catch {
    return [];
  }
}

/**
 * GAP7（按需披露）：员工勾选 ∪ 项目默认 → 启用中的技能，只给**索引**（name + description）。
 * 全文由模型按需调 `load_skill` 读（白名单按会话，见 `skill-tool.ts`）。
 * 读不到/未登记在索引阶段仍列出（路径存在性由 load_skill 如实报错），不编内容。
 */
export function skillsLayer(
  db: unknown,
  refs: readonly string[],
): { text: string; present: boolean; rows: SkillRow[] } {
  const rows = resolveEnabledSkills(db as SqliteDb, refs);
  if (rows.length === 0) return { text: '', present: false, rows };
  const text = [
    '[技能索引]（只列名字与用途；需要具体做法时调用 load_skill(name) 读全文）',
    ...rows.map((row) => `- ${row.name}：${row.description || '（无描述）'}`),
  ].join('\n');
  return { text, present: true, rows };
}

/** GAP7：读技能全文（强制技能用；读不到返回 null——调用方显式标注不可用）。 */
export function loadSkillText(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const text = readFileSync(path, 'utf8').trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/**
 * B6：任务级强制技能（事件 `task_skill_forced`，最后一条为准）。
 * `skill:null`＝显式清除；无事件/坏 payload → null。
 */
export function latestForcedSkill(db: unknown, taskId: number): string | null {
  const row = (db as SqliteDb)
    .prepare("SELECT payload FROM task_events WHERE task_id = ? AND kind = 'task_skill_forced' ORDER BY id DESC LIMIT 1")
    .get(taskId) as { payload?: string } | undefined;
  if (!row?.payload) return null;
  try {
    const parsed = JSON.parse(row.payload) as { skill?: unknown };
    return typeof parsed.skill === 'string' && parsed.skill.trim().length > 0 ? parsed.skill.trim() : null;
  } catch {
    return null;
  }
}

/** OPT-AI-11：同项目相关历史片段（只作证据，不当作当前任务事实）。 */
export function retrievalLayer(hits: readonly RetrievalHit[]): string {
  return `[历史检索]（同项目相关片段；只作证据，不当作当前任务事实）\n${hits
    .map((h) => `- [${h.source}${h.taskId != null ? ` #${h.taskId}` : ''}] ${h.text}`)
    .join('\n')}`;
}

/**
 * ④ 任务基线（**N4**：会话常驻，放 **system 段** ⇒ **不参与历史压缩**）。
 * 证据索引＝该任务最近 ≤10 条 artifacts（`#id 路径`）；无 → `（暂无）`（不臆造）。
 */
export function baselineLayer(input: {
  taskTitle: string;
  taskGoal: string;
  acceptanceText: string;
  workItemId: number | null;
  workItemState: string;
  briefText: string;
  evidenceLines: string[];
}): string {
  return [
    '[任务基线]（**会话常驻**：压缩后仍在）',
    `任务：${input.taskTitle}；目标：${input.taskGoal}`,
    `验收标准：${input.acceptanceText.length > 0 ? input.acceptanceText : '—'}`,
    `工作项：#${input.workItemId ?? '—'}（${input.workItemState}）；简报：${input.briefText}`,
    `证据索引：${input.evidenceLines.length > 0 ? input.evidenceLines.join('；') : '（暂无）'}`,
  ].join('\n');
}

function parseJsonText(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * 读项目上下文：**项目约定层**（`AGENTS.md`——事实标准；缺失回落 `CLAUDE.md`）＋`项目上下文`（`.aico/CONTEXT.md`）。
 * 存在即读、缺失/不可读跳过（不报错、不占位）。GAP5（挂载 3）：`EMPLOYEES §3` 承诺「可读取已有 AGENTS.md」
 * 此前实现为 0——现项目根直读，员工/规划/评审三处共用本函数（`build*Context`）。
 */
export interface ProjectContextRead {
  text: string;
  /** 实际读到的文件（项目根相对路径；截断标记据此告诉模型去哪读全文）。 */
  files: string[];
}

/** RET-F-01：返回文本＋来源路径（给截断标记用；保持只读）。 */
export function readProjectContextDetailed(projectRoot: string): ProjectContextRead {
  const read = (rel: string): string => {
    try {
      const p = join(projectRoot, ...rel.split('/'));
      return existsSync(p) ? readFileSync(p, 'utf8').trim() : '';
    } catch {
      return '';
    }
  };
  const parts: string[] = [];
  const files: string[] = [];
  const agents = read('AGENTS.md');
  if (agents.length > 0) {
    parts.push(`【项目约定 · AGENTS.md】\n${agents}`);
    files.push('AGENTS.md');
  } else {
    const claude = read('CLAUDE.md');
    if (claude.length > 0) {
      parts.push(`【项目约定 · CLAUDE.md】\n${claude}`);
      files.push('CLAUDE.md');
    }
  }
  const ctx = read('.aico/CONTEXT.md');
  if (ctx.length > 0) {
    parts.push(`【项目上下文 · .aico/CONTEXT.md】\n${ctx}`);
    files.push('.aico/CONTEXT.md');
  }
  return { text: parts.join('\n\n'), files };
}

export function readProjectContext(projectRoot: string): string {
  return readProjectContextDetailed(projectRoot).text;
}

/** RET-F-01：抽取标题行（被截断时把章节目录给模型，正文按需 read）。 */
export function contextOutline(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => /^#{1,6}\s+/.test(line.trim()))
    .map((line) => line.trim())
    .slice(0, 24);
}

/**
 * CTX1-6 · 计划复述（进 **user 段**，不改 system 前缀）：
 * 当前计划步骤（running/pending）＋验收摘要＋剩余预算（有才算）＋最近失败/打回（有才写）。
 * 无计划/无任何动态事实 → null（不注入空段）。
 */
export function planRecitationLayer(
  db: unknown,
  input: {
    taskId: number;
    acceptanceText: string;
    task:
      | { budget_tokens?: number | null; cost_tokens?: number | null }
      | undefined;
  },
): string | null {
  const dbh = db as SqliteDb;
  const steps = listPlanSteps(dbh, input.taskId);
  const lines: string[] = [];
  if (steps.length > 0) {
    const done = steps.filter((s) => s.state === 'done').length;
    lines.push(`【当前计划复述】进度 ${done}/${steps.length}`);
    const running = steps.filter((s) => s.state === 'running');
    if (running.length > 0) {
      lines.push(`进行中：${running.map((s) => `${s.idx}. ${s.text}`).join('；')}`);
    }
    const next = steps.find((s) => s.state === 'pending');
    if (next) lines.push(`下一步：${next.idx}. ${next.text}`);
  }
  const acceptance = input.acceptanceText.trim();
  if (acceptance.length > 0) {
    lines.push(`验收摘要：${acceptance.length <= 160 ? acceptance : `${acceptance.slice(0, 160)}…`}`);
  }
  const budget = input.task?.budget_tokens;
  if (typeof budget === 'number' && Number.isFinite(budget) && budget > 0) {
    const used = typeof input.task?.cost_tokens === 'number' && Number.isFinite(input.task.cost_tokens) ? input.task.cost_tokens : 0;
    lines.push(`剩余预算：${Math.max(0, budget - used)} tokens（已用 ${used}/${budget}）`);
  }
  const setback = latestSetbackText(
    listTaskEvents(dbh, input.taskId) as Array<{ kind: string; payload: string }>,
  );
  if (setback) lines.push(`最近失败/打回：${setback}`);
  if (lines.length === 0) return null;
  return capLayer('planRecitation', lines.join('\n'), LAYER_TOKEN_CAPS.planRecitation!).text;
}

export function buildEmployeeContext(db: unknown, input: EmployeeContextInput): EmployeeContext {
  const dbh = db as SqliteDb;
  const task = getTaskById(dbh, input.taskId) as
    | {
        id?: number;
        short_id?: string | null;
        title?: string;
        goal?: string;
        acceptance?: unknown;
        state?: string | null;
        project_id?: number | null;
        budget_tokens?: number | null;
        cost_tokens?: number | null;
      }
    | undefined;
  const project = task?.project_id != null ? (getProjectById(dbh, task.project_id) as { root_dir?: string; default_skills?: string } | undefined) : undefined;
  const projectRoot = project?.root_dir ?? process.cwd();

  const workItem =
    input.workItemId != null
      ? (getWorkItem(dbh, input.workItemId) as { state?: string; brief?: unknown } | undefined)
      : undefined;

  const empRow = (dbh.prepare('SELECT name, role, persona, skills, mcps FROM employees WHERE id = ?').get(input.employeeId) ?? {}) as {
    name?: string;
    role?: string;
    persona?: string;
    skills?: string;
    mcps?: string;
  };

  const projectCtxRead = readProjectContextDetailed(projectRoot);
  const projectCtx = projectCtxRead.text;
  const acceptance = parseJsonText(task?.acceptance);
  // B0-2：验收层带可执行命令（「（机器检查：pnpm test）」）——员工要能对准验收自查，
  // 否则只知道「测试通过」却不知道过关命令是什么。
  const acceptanceText = Array.isArray(acceptance)
    ? acceptance
        .filter((a) => !isDocsCheckAcceptance(a))
        .map((a) => {
          if (typeof a === 'string') return a;
          const text = typeof (a as { text?: unknown })?.text === 'string' ? String((a as { text: string }).text) : '';
          const check =
            typeof (a as { check?: unknown })?.check === 'string' ? String((a as { check: string }).check).trim() : '';
          if (text.length === 0) return check.length > 0 ? `（机器检查：${check}）` : '';
          return check.length > 0 ? `${text}（机器检查：${check}）` : text;
        })
        .filter((s) => s.length > 0)
        .join('；')
    : '';

  // CTX1-6：计划复述（user 段；每轮 run 的提示里带当前步骤/验收/预算/最近失败）。
  const recitation =
    input.includePlanRecitation === false || !isCtxEnabled()
      ? null
      : planRecitationLayer(dbh, { taskId: input.taskId, acceptanceText, task });

  const brief = parseJsonText(workItem?.brief);
  // 结构化 brief（`{text, touchedPaths}`，B0-7 的 inplace 整树认领）只把 text 交给模型；
  // 路径认领是宿主侧并发元数据，不应以 JSON 形式污染提示词。
  const briefObj = brief && typeof brief === 'object' ? (brief as { text?: unknown }) : null;
  const briefText =
    typeof brief === 'string'
      ? brief
      : briefObj && typeof briefObj.text === 'string'
        ? briefObj.text
        : brief
          ? JSON.stringify(brief)
          : '（无）';

  // N4：证据索引（最近 ≤10 条；只读）
  const evidenceLines = listArtifactsByTask(dbh, input.taskId)
    .slice(-10)
    .map((a) => `#${a.id} ${a.path}`);

  // G11：员工记忆（项目分区；无任务 → 通用分区 0）
  // D-17：评审会话（critic/verifier）不读员工 L1/检索；verifier 连事实层也不注入。
  const skipEmployeeMemory = input.skipEmployeeMemory === true;
  const memory = skipEmployeeMemory ? '' : readMemory(dbh, { employeeId: input.employeeId, projectId: task?.project_id ?? 0 });
  const memoryBrief = skipEmployeeMemory ? '（暂无）' : buildProjectMemoryBrief(memory);
  const factPrincipal: Principal | null =
    input.memoryPrincipal === undefined ? { kind: 'employee', employeeId: input.employeeId } : input.memoryPrincipal;
  const factsText =
    factPrincipal == null
      ? ''
      : renderBrief(
          new SqliteMemoryStore(dbh).brief({
            principal: factPrincipal,
            projectId: task?.project_id ?? null,
            taskId: task?.id ?? null,
            text: `${task?.title ?? ''} ${task?.goal ?? ''}`,
          }).sections,
        );

  // GAP7：技能索引＝员工勾选 ∪ 项目默认；B6 强制技能额外加载全文（任务级覆盖）。
  const skillRefs = [...parseRefList(empRow.skills), ...parseRefList(project?.default_skills)];
  const skills = skillsLayer(dbh, skillRefs);
  const forcedSkill = task?.id != null ? latestForcedSkill(dbh, task.id) : null;
  const forcedRow = forcedSkill != null ? getSkillByName(dbh, forcedSkill) : undefined;
  const forcedUsable = forcedRow != null && forcedRow.enabled === 1;
  const skillRows = [...skills.rows];
  if (forcedUsable && !skillRows.some((row) => row.id === forcedRow.id)) skillRows.push(forcedRow);
  const skillIndexRaw =
    skillRows.length > 0
      ? [
          '[技能索引]（只列名字与用途；需要具体做法时调用 load_skill(name) 读全文）',
          ...skillRows.map((row) => `- ${row.name}：${row.description || '（无描述）'}`),
        ].join('\n')
      : '';
  const skillCapped = capLayer('skillIndex', skillIndexRaw, LAYER_TOKEN_CAPS.skillIndex!);
  const skillIndex = skillCapped.text;
  const forcedText = forcedUsable ? loadSkillText(forcedRow.path) : null;
  const forcedClipped = forcedText != null && forcedText.length > 20_000;
  // GAP6：只把**分配给本员工**且启用的 MCP server 名字交给会话；工具详情由 mcp_list/tool_search 按需查。
  const mcpServers = resolveEnabledMcpServers(dbh, parseRefList(empRow.mcps));
  const mcpIndex =
    mcpServers.length > 0
      ? [
          '[MCP 服务]（仅列分配给你的 server；用 mcp_list / tool_search 查工具，不预载全部工具）',
          ...mcpServers.map((row) => `- ${row.name}（${row.transport}，${row.exposure}）`),
        ].join('\n')
      : '';
  // OPT-AI-11：同项目历史检索（开关缺省开；无命中不注入空段）。
  const retrievalEnabled = !skipEmployeeMemory && readSetting(dbh, 'memory.retrieval') !== false;
  // RET-F-03：查询文本并入工作简报＋计划步骤（原先只用标题/目标，brief/计划里的关键词用不上）。
  const planStepsForRetrieval = retrievalEnabled ? listPlanSteps(dbh, input.taskId) : [];
  const retrievalHits = retrievalEnabled
    ? searchRelated(dbh, {
        projectId: task?.project_id ?? 0,
        taskId: task?.id ?? null,
        // 简报/计划词更具体，放前面（retrievalTerms 最多取 4 个，标题的 2-gram 会挤掉它们）。
        text: `${briefText} ${planStepsForRetrieval.map((s) => s.text).join(' ')} ${task?.title ?? ''} ${task?.goal ?? ''}`,
        limit: 3,
      })
    : [];
  // OPT-AI-12：few-shot（缺省开；显式 false 关）。
  const fewShot = fewShotEnabled(readSetting(dbh, 'prompt.fewShot'));

  const answers = input.mailboxAnswers ?? [];
  const asks = input.mailboxAsks ?? [];
  // CTX1-4 / RET-F-01：项目约定超限时给「章节标题＋去哪读全文」，不静默丢中段规则。
  const projectCtxCapped = capLayer('projectContext', projectCtx, LAYER_TOKEN_CAPS.projectContext!, {
    ...(projectCtxRead.files.length > 0
      ? { hint: `完整原文：${projectCtxRead.files.map((f) => `read ${f}`).join(' / ')}` }
      : {}),
    outline: contextOutline(projectCtx),
  });
  const bossCapped = capLayer('bossText', input.bossText ?? '', LAYER_TOKEN_CAPS.bossText!);
  const briefCapped = capLayer('workBrief', briefText, LAYER_TOKEN_CAPS.workBrief!);
  // RET-F-02：L1 记忆也要有预算（时间序，保留近期为主）；超限显式标记。
  const memoryCapped = skipEmployeeMemory
    ? null
    : capLayer('memory', memoryLayer(memory), LAYER_TOKEN_CAPS.employeeMemory!, {
        mode: 'tail-heavy',
        hint: '完整记忆在「设置 · 员工 · 记忆」可查',
      });

  const systemPrompt = [
    PLATFORM_LAYER,
    roleLayer(empRow.role ?? ''),
    personaLayer(empRow.persona ?? ''),
    ...(fewShot ? [fewShotLayer('employee', true)] : []),
    ...(skillIndex.length > 0 ? [skillIndex] : []),
    // RET-1 P3：A/B 开关（AICO_REPO_MAP=on）时提示先用 repo_map。
    ...(isRepoMapEnabled() ? [REPO_MAP_HINT_LAYER] : []),
    ...(forcedText != null
      ? [
          wrapExternalData(
            `[强制技能：${forcedSkill}]`,
            `${forcedText.slice(0, 20_000)}${forcedClipped ? '\n…（已截断）' : ''}`,
          ),
        ]
      : []),
    ...(forcedSkill != null && forcedText == null
      ? [`[强制技能不可用] ${forcedSkill}（未登记/已停用/文件读不到）——本任务未加载该技能`]
      : []),
    ...(mcpIndex.length > 0 ? [mcpIndex] : []),
    ...(skipEmployeeMemory ? [] : [projectMemoryBriefLayer(memoryBrief), memoryCapped!.text]),
    ...(factsText.length > 0 ? [factsText] : []),
    ...(retrievalHits.length > 0 ? [retrievalLayer(retrievalHits)] : []),
    baselineLayer({
      taskTitle: task?.title ?? '—',
      taskGoal: task?.goal ?? '—',
      acceptanceText,
      workItemId: input.workItemId ?? null,
      workItemState: workItem?.state ?? '—',
      briefText: briefCapped.text,
      evidenceLines,
    }),
    // 放在 system 段**最后一行**（离生成最近；MiMo 实测会忽略靠前的工具要求）。
    ...(input.workItemId != null ? [DELIVERY_DISCIPLINE_LAYER] : []),
  ].join('\n\n');

  const userPrompt = [
    `【老板原话】${bossCapped.text.trim().length > 0 ? bossCapped.text.trim() : '（无）'}`,
    `【项目上下文】
${DATA_NOT_INSTRUCTION}
${projectCtxCapped.text.length > 0 ? projectCtxCapped.text : '（未提供）'}`,
    ...(recitation ? [recitation] : []),
    // R2-2（G7 回灌）：未读的同事答复——会话开始前执行器查、结束后标读（崩溃则下轮重读，不静默丢失）。
    ...(answers.length > 0
      ? [`【同事答复】\n${DATA_NOT_INSTRUCTION}\n${answers.map((a) => `- 来自 员工#${a.from}：${a.answer}`).join('\n')}`]
      : []),
    // BRK12：点名问本员工的未结提问；askDedupeKey 供 answer_colleague 精确作答。
    ...(asks.length > 0
      ? [
          `【同事提问】\n${DATA_NOT_INSTRUCTION}\n${asks
            .map(
              (a) =>
                `- 员工#${a.from}${a.blocking ? '（阻塞等答复）' : ''}：${a.question}｜askDedupeKey=\`${a.askDedupeKey}\``,
            )
            .join('\n')}\n若你能回答，调用 \`answer_colleague\`（askDedupeKey 照抄，answer 一句话）；只能答问你的问题。`,
        ]
      : []),
    // 交付要求放在 user prompt 末尾（最后一次提醒；与 system 尾行同一口径）。
    ...(input.workItemId != null
      ? ['【交付要求】完成后必须调用 `submit_work_item` 提交（summary 必填）；直接文字回答不算完成，会判失败。']
      : []),
  ].join('\n\n');

  // CTX1-2：分层遥测（纯投影；contextWindow 未知 → null，渲染层显 —）。
  const telemetry = buildTelemetry(
    [
      { name: 'platform', text: PLATFORM_LAYER, side: 'system' },
      { name: 'role', text: roleLayer(empRow.role ?? ''), side: 'system' },
      { name: 'persona', text: personaLayer(empRow.persona ?? ''), side: 'system' },
      ...(fewShot ? [{ name: 'fewShot', text: fewShotLayer('employee', true), side: 'system' as const }] : []),
      ...(skillIndex.length > 0 ? [{ name: 'skillIndex', text: skillIndex, side: 'system' as const, truncated: skillCapped.truncated, tokensBeforeCap: skillCapped.tokensBeforeCap }] : []),
      ...(forcedText != null ? [{ name: 'forcedSkill', text: forcedText.slice(0, 20_000), side: 'system' as const }] : []),
      ...(mcpIndex.length > 0 ? [{ name: 'mcpIndex', text: mcpIndex, side: 'system' as const }] : []),
      ...(isRepoMapEnabled() ? [{ name: 'repoMapHint', text: REPO_MAP_HINT_LAYER, side: 'system' as const }] : []),
      ...(skipEmployeeMemory ? [] : [{ name: 'memoryBrief', text: projectMemoryBriefLayer(memoryBrief), side: 'system' as const }]),
      ...(skipEmployeeMemory ? [] : [{ name: 'memory', text: memoryCapped!.text, side: 'system' as const, truncated: memoryCapped!.truncated, tokensBeforeCap: memoryCapped!.tokensBeforeCap }]),
      ...(factsText.length > 0 ? [{ name: 'facts', text: factsText, side: 'system' as const }] : []),
      ...(retrievalHits.length > 0 ? [{ name: 'retrieval', text: retrievalLayer(retrievalHits), side: 'system' as const }] : []),
      { name: 'baseline', text: baselineLayer({ taskTitle: task?.title ?? '—', taskGoal: task?.goal ?? '—', acceptanceText, workItemId: input.workItemId ?? null, workItemState: workItem?.state ?? '—', briefText: briefCapped.text, evidenceLines }), side: 'system' },
      ...(input.workItemId != null ? [{ name: 'deliveryDiscipline', text: DELIVERY_DISCIPLINE_LAYER, side: 'system' as const }] : []),
      { name: 'bossText', text: bossCapped.text, side: 'user', truncated: bossCapped.truncated, tokensBeforeCap: bossCapped.tokensBeforeCap },
      { name: 'projectContext', text: projectCtxCapped.text, side: 'user', truncated: projectCtxCapped.truncated, tokensBeforeCap: projectCtxCapped.tokensBeforeCap },
      ...(recitation ? [{ name: 'planRecitation', text: recitation, side: 'user' as const, truncated: recitation.includes('【planRecitation 已截断') }] : []),
      ...(answers.length > 0 ? [{ name: 'mailboxAnswers', text: answers.map((a) => `- 来自 员工#${a.from}：${a.answer}`).join('\n'), side: 'user' as const }] : []),
      ...(asks.length > 0 ? [{ name: 'mailboxAsks', text: asks.map((a) => a.question).join('\n'), side: 'user' as const }] : []),
      ...(input.workItemId != null ? [{ name: 'deliveryNotice', text: '完成后必须调用 submit_work_item 提交', side: 'user' as const }] : []),
    ],
    null,
  );

  return {
    systemPrompt,
    userPrompt,
    meta: {
      layers: {
        platform: PLATFORM_LAYER.length > 0,
        role: true,
        persona: (empRow.persona ?? '').trim().length > 0,
        /** G11：有真实记忆才记 true（无 → 占位段仍在场，不当真）。 */
        memory: memory.trim().length > 0,
        /** N5 尾项：短简报有真实索引才 true（无记忆 → 占位不当真）。 */
        memoryBrief: memoryBrief !== '（暂无）',
        /** D-17：L2/L3 事实层有真实内容。 */
        facts: factsText.length > 0,
        /** GAP7：有技能索引（真实可加载项）。 */
        skills: skillRows.length > 0,
        /** OPT-AI-11：有检索命中（空 → 不注入空段）。 */
        retrieval: retrievalHits.length > 0,
        /** OPT-AI-12：few-shot 是否注入。 */
        fewShot,
        project: projectCtx.length > 0,
        task: !!task,
        /** N4：任务基线已进 **system 段**（压缩不丢）；无任务 → 占位段仍在场、但这层按"有无真实基线"记 false（不臆造）。 */
        baseline: !!task,
        /** CTX1-6：user 段带计划复述（无计划/无动态事实 → false）。 */
        planRecitation: recitation != null,
      },
      projectRoot,
      cwd: projectRoot,
      skillRefs: skillRows.map((row) => ({ name: row.name, description: row.description, path: row.path })),
      forcedSkill,
      mcpRefs: mcpServers.map((row) => row.name),
      telemetry,
    },
  };
}

// ───────────── G4（RC-5）· critic / verifier 评审上下文（**只加**；上面 `buildEmployeeContext` 不变） ─────────────

/** 评审角色规则（critic / verifier 各自职责；与 ①平台底座 同为 system 段）。 */
export function reviewRoleLayer(role: 'critic' | 'verifier'): string {
  if (role === 'critic') {
    return "[评审角色] 你是 critic：**评审计划**的可执行性、风险与验收覆盖；不得改需求；输出结构化结论 {verdict:'approve'|'revise', notes}。";
  }
  return "[评审角色] 你是 verifier：**独立验证**实现是否满足验收（**不采信实现者自述**，以证据为准）；输出结构化结论 {verdict:'pass'|'fail', notes}；证据不足 → fail。";
}

export interface ReviewContextInput {
  role: 'critic' | 'verifier';
  taskId: number;
  workItemId?: number | null;
  reviewerEmployeeId: number;
  bossText?: string | null;
  /** M3-DOC-4：宿主已跑的机器检查摘要（verifier 参考；失败已被硬门拦截，不会到这里）。 */
  machineChecks?: string | null;
}

/**
 * 评审会话上下文（critic / verifier）。**只加**：不改 `buildEmployeeContext`；复用平台/人设/项目上下文与验收读取。
 * - critic：材料 = 任务简报 + 验收 + **被评审计划（`plan_steps`）** + 工作项列表（计划执行面）；
 *   **V3 修（2026-10-15）**：原材料**不含计划步骤** ⇒ critic 只能说"没有可评审的计划"⇒ `revise` ⇒
 *   L1 结构上到不了 `awaiting_approval`（真机实测，见 `records/verify/verify-ui-first-run.md` V3 节）。
 * - verifier：材料 = 任务简报 + 验收 + 被验工作项的 `result`（实现者产出）。
 */
export function buildReviewContext(db: unknown, input: ReviewContextInput): EmployeeContext {
  const dbh = db as SqliteDb;
  const base = buildEmployeeContext(dbh, {
    employeeId: input.reviewerEmployeeId,
    taskId: input.taskId,
    workItemId: input.workItemId ?? null,
    bossText: input.bossText ?? null,
    // D-17：critic 只看 L2/L3 事实；verifier 0 记忆；两者都不读员工 L1/历史检索。
    memoryPrincipal: input.role === 'critic' ? { kind: 'critic' } : null,
    skipEmployeeMemory: true,
    // CTX1-6：评审材料已含计划/工作项，不再重复计划复述（避免双份噪音）。
    includePlanRecitation: false,
  });
  const task = getTaskById(dbh, input.taskId) as { project_id?: number | null } | undefined;
  const project = task?.project_id != null ? (getProjectById(dbh, task.project_id) as { root_dir?: string } | undefined) : undefined;
  const projectRoot = project?.root_dir ?? process.cwd();
  const projectCtx = readProjectContext(projectRoot);

  let material = '';
  // verifier：未完成步骤提示（F-02 引导——不填 planStepsNote 会被宿主改 fail 并返工）。
  let unfinishedHint = '';
  if (input.role === 'critic') {
    // V3 修：critic 评审的对象是**计划**——材料必须以 plan_steps 为首（此前只有工作项 ⇒ 必然 revise）
    const steps = listPlanSteps(dbh, input.taskId);
    // plan_steps.idx 是 **1 基**（`replacePlanSteps` 按 i+1 写入）；这里直接用它，
    // 不能再 +1（2026-11-06 D4 复查抓到的 off-by-one：critic 会把第 1 步说成第 2 步）。
    const stepsText = steps.length
      ? steps.map((s) => `${s.idx}. [${s.state}] ${s.text}`).join('\n')
      : '（无计划步骤——无计划可评，应给 revise 并在 notes 说明缺什么）';
    const items = (dbh.prepare('SELECT id, state, title FROM work_items WHERE task_id = ? ORDER BY id').all(input.taskId) ?? []) as Array<{
      id: number;
      state: string;
      title: string;
    }>;
    const itemsText = items.length
      ? items.map((w) => `#${w.id}（${w.state}）${w.title}`).join('\n')
      : '（无工作项）';
    material = [`【被评审计划（plan_steps）】\n${stepsText}`, `【工作项】\n${itemsText}`].join('\n\n');
  } else {
    if (input.workItemId != null) {
      const wi = getWorkItem(dbh, input.workItemId) as { result?: unknown; state?: string } | undefined;
      const result = parseJsonText(wi?.result);
      material = `工作项 #${input.workItemId}（${wi?.state ?? '—'}）产出：${
        result == null ? '（无）' : typeof result === 'string' ? result : JSON.stringify(result)
      }`;
    } else {
      material = '（未指定工作项）';
    }
    // F-02（2026-11-06 老板裁）：verifier 必须看到计划步骤状态——否则「计划 7/12 步」它无从判断
    // （2026-11-05 真机：任务 done 但 7 步仍 pending，verifier 只依工作项产出判了 pass）。
    // 未完成**不是硬门**，但必须交代（见 userPrompt 口径与 submit_review.planStepsNote 的宿主校验）。
    const steps = listPlanSteps(dbh, input.taskId);
    if (steps.length > 0) {
      const closed = steps.filter((s) => s.state === 'done' || s.state === 'skipped').length;
      const stepsText = steps.map((s) => `${s.idx}. [${s.state}] ${s.text}`).join('\n');
      material += `\n\n【计划步骤（${closed}/${steps.length} 已关）】\n${stepsText}`;
      const unfinished = steps.filter((s) => s.state !== 'done' && s.state !== 'skipped');
      if (unfinished.length > 0) {
        unfinishedHint =
          `\n\n【未完成步骤（${unfinished.length}/${steps.length}）】第 ${unfinished.map((s) => s.idx).join('、')} 步；` +
          '如果你要判 pass，`submit_review.planStepsNote` **必填**，逐条覆盖这些步骤（第 N 步：状态 / 为什么没做 / 结论）；' +
          '不填会被宿主改判 fail 并触发返工。';
      }
    }
  }

  // 修（2026-10-14 真机暴露）：**必须用 `base.systemPrompt`**——自建 systemPrompt 会把 `baselineLayer`
  //（题目/目标/验收/工作项/证据）与记忆层**整段丢掉** ⇒ 评审者看不到"评审对象是什么"（critic 评不了计划）。
  const systemPrompt = [base.systemPrompt, ...(fewShotEnabled(readSetting(dbh, 'prompt.fewShot')) ? [fewShotLayer(input.role, true)] : []), reviewRoleLayer(input.role)].join('\n\n');
  const userPrompt = [
    base.userPrompt,
    `【评审角色】${input.role}`,
    `【被评审材料】${material}`,
    ...(input.machineChecks
      ? [`【机器检查（宿主执行；任一条失败即硬门，不采信模型翻案）】\n${input.machineChecks}`]
      : []),
    ...(input.role === 'verifier'
      ? [
          '【计划步骤口径（F-02，老板 2026-11-06 裁）】未完成步骤**不是硬门**——按验收标准与产物判定即可；' +
            '但必须在 `submit_review.planStepsNote` 里逐条交代未完成步骤（第 N 步：状态 / 为什么没做 / 结论）。' +
            '未交代时宿主会把 pass 改为 fail（不设「全部 done 才可通过」的硬门）。' + unfinishedHint,
        ]
      : []),
    `【输出要求】用 \`submit_review\` 提交结构化结论（${input.role === 'critic' ? 'approve|revise' : 'pass|fail'}）。`,
  ].join('\n\n');

  return {
    systemPrompt,
    userPrompt,
    meta: {
      ...base.meta,
      layers: { ...base.meta.layers, role: true, project: projectCtx.length > 0 },
      // CTX1-2：评审在 base 之后追加了角色规则/材料/机器检查——读数同步扩，不少记。
      telemetry: base.meta.telemetry
        ? extendTelemetry(base.meta.telemetry, [
            { name: 'reviewRole', text: systemPrompt.slice(base.systemPrompt.length + 2), side: 'system' },
            { name: 'reviewMaterial', text: userPrompt.slice(base.userPrompt.length + 2), side: 'user' },
          ])
        : undefined,
    },
  };
}

// ───────────── R3-1 · planning 会话上下文（**只加**；与 `buildReviewContext` 同形） ─────────────

/** 规划角色规则（与 ①平台底座 同为 system 段）。 */
export function plannerRoleLayer(): string {
  return '[规划角色] 你是规划者：把任务目标拆成 1–12 步**可执行、可验收**的计划（只规划，不写代码、不做调研）；用 `submit_plan` 提交结构化计划。';
}

export interface PlanningContextInput {
  taskId: number;
  plannerEmployeeId: number;
  bossText?: string | null;
}

/**
 * 规划会话上下文（`planning` 阶段产出计划）。**只加**：不改 `buildEmployeeContext`；
 * 材料＝任务简报 + 验收（`buildEmployeeContext` 的 userPrompt 已含，不重复拼）。
 */
export function buildPlanningContext(db: unknown, input: PlanningContextInput): EmployeeContext {
  const dbh = db as SqliteDb;
  const base = buildEmployeeContext(dbh, {
    employeeId: input.plannerEmployeeId,
    taskId: input.taskId,
    bossText: input.bossText ?? null,
  });
  const task = getTaskById(dbh, input.taskId) as { project_id?: number | null } | undefined;
  const project = task?.project_id != null ? (getProjectById(dbh, task.project_id) as { root_dir?: string } | undefined) : undefined;
  const projectRoot = project?.root_dir ?? process.cwd();
  const projectCtx = readProjectContext(projectRoot);

  // 修（2026-10-14 真机暴露）：**必须用 `base.systemPrompt`**——自建会把 `baselineLayer`（题目/目标/验收）
  // 整段丢掉 ⇒ 规划者看不到任务是什么（真机现场：幕僚长以为"入参为空"，计划第一步变成"先向老板澄清"）。
  const taskRow = getTaskById(dbh, input.taskId) as { title?: string; goal?: string } | undefined;
  const systemPrompt = [
    base.systemPrompt,
    ...(fewShotEnabled(readSetting(dbh, 'prompt.fewShot')) ? [fewShotLayer('planner', true)] : []),
    plannerRoleLayer(),
  ].join('\n\n');
  // 重规划 v+1（工单）：已有上一版计划 ⇒ 这是重规划——带上**上一版步骤＋打回意见**（"带意见重规划，不从头再来"）。
  const prevSteps = listPlanSteps(dbh, input.taskId);
  const reviseNotes = prevSteps.length > 0 ? latestReviseNotes(listTaskEvents(dbh, input.taskId)) : null;
  const replanBlock =
    prevSteps.length > 0
      ? [
          '【上一版计划（本次为**重规划**；请在其基础上修订，不从头再来）】',
          prevSteps.map((s, i) => `${i + 1}. ${s.text}`).join('\n'),
          ...(reviseNotes ? [`【打回意见】${reviseNotes}`] : []),
        ].join('\n')
      : null;
  const userPrompt = [
    base.userPrompt,
    `【本任务】${taskRow?.title ?? '—'}：${(taskRow?.goal ?? '—').trim() || '—'}`,
    ...(replanBlock ? [replanBlock] : []),
    '【输出要求】用 `submit_plan` 提交计划（1–12 步，每步一句可执行/可验收的话）。',
  ].join('\n\n');

  return {
    systemPrompt,
    userPrompt,
    meta: {
      ...base.meta,
      layers: { ...base.meta.layers, role: true, project: projectCtx.length > 0 },
      // CTX1-2：规划在 base 之后追加了规划角色规则/本任务/上一版计划——读数同步扩。
      telemetry: base.meta.telemetry
        ? extendTelemetry(base.meta.telemetry, [
            { name: 'plannerRole', text: systemPrompt.slice(base.systemPrompt.length + 2), side: 'system' },
            { name: 'planningBrief', text: userPrompt.slice(base.userPrompt.length + 2), side: 'user' },
          ])
        : undefined,
    },
  };
}

/**
 * 最近一次**打回意见**（重规划输入）：倒序取首个 `revise` 或 `plan_reviewed{verdict:'revise'}` 事件的 notes。
 * 无则 `null`（不臆造"老板说了什么"）。事件 `payload` 在库里是 JSON 文本，解析失败即跳过（不抛）。
 */
function latestReviseNotes(events: ReadonlyArray<{ kind: string; payload: string }>): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]!;
    if (e.kind !== 'revise' && e.kind !== 'plan_reviewed') continue;
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(e.payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    // 注：`revise` 迁移写入的 kind 是 `plan_reviewed`（老板/机内两路）——老板路 payload **无 verdict**，
    // 只有 critic 路带 `verdict:'approve'|'revise'` ⇒ 只跳过「显式 approve」的行，其余都算打回来料。
    if (e.kind === 'plan_reviewed' && typeof payload.verdict === 'string' && payload.verdict !== 'revise') continue;
    const notes = typeof payload.notes === 'string' ? payload.notes.trim() : '';
    return notes.length > 0 ? notes : null;
  }
  return null;
}
