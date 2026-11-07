/**
 * OPT-M9-1 · `permissionGate` —— 三层权限模型（`PLAN §16`）。
 *
 * 三层：
 *  - **工具层（capability）**：员工能力档决定 TA 能拿到哪些工具类（`sandbox` 只读 / `standard` +写+命令 / `trusted` +安装）；
 *  - **路径层（scope）**：文件读写必须落在**项目根 / 工作目录**内；项目外默认拒绝（`..` 穿越拒绝）；敏感路径默认拒；
 *  - **动作层（consent）**：**对外动作 / 花钱 / 安装系统依赖 / 危险命令** → **一律 Ask**（任何放行档都不自动放行）。
 *
 * 有效权限 = 能力档 ∩ 放行档；`risk_level = L2` 时**放行档自动收紧一档**。
 * 纯函数（无 IO，可单测）；`PLAN §16.4` 的接线（`engine/actions` 执行前过 gate + 落
 * `permission_requested` / `permission_decision` 事件、审批复用 `approvals`）在引擎侧。
 */

import { precheckCommand } from './command-precheck.js';
import { isReadOnlyBashCommand } from './readonly-bash.js';

export type PermissionDecision = 'allow' | 'ask' | 'deny';
export type CapabilityTier = 'sandbox' | 'standard' | 'trusted';
export type Autonomy = 'strict' | 'standard' | 'loose';
export type ToolCategory = 'read' | 'search' | 'write' | 'command' | 'install' | 'external' | 'spend' | 'manage' | 'other';

/** D-19 P1：频道助手项目写权限（项目级；`full` v1 不做）。 */
export type AssistantWriteMode = 'read-only' | 'confirm' | 'auto';

export interface ToolCall {
  name: string;
  args?: Record<string, unknown>;
}

/** `permission_policies.policy` JSON 的形状（缺省全空）。 */
export interface PermissionPolicy {
  /** 额外允许的路径前缀（绝对路径）。 */
  pathAllow?: string[];
  /** 额外拒绝的路径前缀。 */
  pathDeny?: string[];
  /** 命令黑名单（正则字符串）。 */
  commandDenylist?: string[];
  /** 需逐次批准的命令（正则字符串，如 push/rm -rf）。 */
  consentRules?: string[];
  /**
   * D-19 P1：频道助手写权限（项目级；缺省＝confirm）。
   * 只影响频道助手（无任务会话），不影响员工任务会话的 autonomy。
   */
  assistantWriteMode?: AssistantWriteMode;
  /** 已授予的临时放行（`once`/`task`/`project`/`session`，可带过期与会话维度）。 */
  grants?: Array<{
    rule: string;
    scope: 'once' | 'task' | 'project' | 'session';
    expiresAt?: number | null;
    /** G1 余项：会话维度（最小范围 = 会话 × 规则）；缺省/无 = 任务级（回落）。 */
    sessionKey?: string;
    /**
     * D-19 P1：只对频道助手（`employeeId=0`）生效。
     * 项目级频道 grant 若不带此标记会扩散到同项目员工任务会话——必须隔离。
     */
    assistantOnly?: boolean;
    toolName?: string;
    grantedBy?: string;
    grantedAt?: number;
  }>;
}

export interface GateContext {
  capabilityTier: CapabilityTier;
  autonomy: Autonomy;
  /** 任务风险等级（0/1/2）；L2 → 放行档自动收紧一档。 */
  riskLevel: number;
  /** 任务工作目录 / 项目根（路径包含校验的允许根）。 */
  projectRoot: string;
  cwd?: string;
  policy?: PermissionPolicy;
  now?: number;
}

export interface GateResult {
  decision: PermissionDecision;
  reason: string;
  /** 命中的规则名（审计用）。 */
  rule?: string;
}

const TIER_RANK: Record<CapabilityTier, number> = { sandbox: 0, standard: 1, trusted: 2 };

/** 各工具类所需的最低能力档。 */
const CATEGORY_MIN_TIER: Record<ToolCategory, CapabilityTier> = {
  read: 'sandbox',
  search: 'sandbox',
  manage: 'sandbox',
  other: 'sandbox',
  write: 'standard',
  command: 'standard',
  external: 'standard',
  spend: 'standard',
  install: 'trusted',
};

/** 目录穿越 / 敏感路径默认拒绝（`PLAN §16.2`）。 */
const SENSITIVE = [
  '.ssh',
  '.aws',
  '.env',
  'id_rsa',
  '.npmrc',
  'cookies',
  'login data',
  '.aico/secrets',
  // B0-9：本机数据库 / 导出包 / 微信凭据（审查指出的遗漏面）。
  'aico.sqlite',
  'aico.sqlite-wal',
  'aico.sqlite-shm',
  '.aico/exports',
  'wechat.json',
];

/**
 * B0-9（58 §3.1 洞 3）：**网络外发命令族**——`gate` 此前按工具名分类，bash 内容不受 external 闸门约束
 * ⇒ `curl --data @文件`、`git push`、`scp` 在 standard 档自动放行，与「对外动作永不自动放行」承诺相悖。
 * 这里按命令文本（含 bash -c/脚本串）识别；命中一律 ask（批准后按 `consent:egress` 规则放行）。
 */
const EGRESS_COMMAND_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\bcurl\b/i, label: 'curl' },
  { re: /\bwget\b/i, label: 'wget' },
  { re: /\binvoke-webrequest\b|\biwr\b/i, label: 'Invoke-WebRequest' },
  { re: /\binvoke-restmethod\b|\birm\b/i, label: 'Invoke-RestMethod' },
  { re: /\bgit\s+push\b/i, label: 'git push' },
  { re: /\bgit\s+remote\s+(add|set-url)\b/i, label: 'git remote' },
  { re: /\b(npm|pnpm|yarn)\s+publish\b/i, label: 'package publish' },
  { re: /\bscp\b|\bsftp\b/i, label: 'scp/sftp' },
  { re: /\bssh\b/i, label: 'ssh' },
  { re: /\bsend-mailmessage\b/i, label: 'send mail' },
];

/** 返回命中的外发命令族标签；无 → null（纯函数，可测）。 */
export function detectEgressCommand(command: string): string | null {
  const text = command ?? '';
  if (text.trim().length === 0) return null;
  for (const { re, label } of EGRESS_COMMAND_PATTERNS) {
    if (re.test(text)) return label;
  }
  return null;
}

export function toolCategory(name: string): ToolCategory {
  const n = name.toLowerCase();
  if (['read', 'ls', 'list', 'find'].includes(n)) return 'read';
  if (['grep', 'search', 'glob'].includes(n)) return 'search';
  // D-19 P1：建目录与写文件同属写类（专用工具名也走同一闸门，不漏到 other）。
  if (['write', 'edit', 'create_file', 'apply_patch', 'rm', 'delete', 'move', 'mkdir', 'create_dir', 'create_directory'].includes(n)) return 'write';
  if (['bash', 'powershell', 'shell', 'exec', 'run_command', 'cmd'].includes(n)) return 'command';
  if (['install', 'npm_install', 'pnpm_add', 'pip_install', 'apt', 'choco', 'winget'].includes(n)) return 'install';
  if (['web', 'fetch', 'http', 'curl', 'send_email', 'http_request', 'git_push', 'publish', 'deploy', 'mcp_call', 'mcp'].includes(n)) return 'external';
  if (['spend', 'purchase', 'subscribe', 'pay'].includes(n)) return 'spend';
  if (['submit_work_item', 'ask_colleague', 'request_review', 'report_progress', 'escalate_to_boss', 'mcp_list', 'tool_search', 'load_skill'].includes(n)) return 'manage';
  return 'other';
}

export function downgradeAutonomy(a: Autonomy, riskLevel: number): Autonomy {
  if (riskLevel < 2) return a;
  return a === 'loose' ? 'standard' : 'strict';
}

function normalize(p: string): string {
  const segments: string[] = [];
  for (const seg of p.trim().replace(/\\/g, '/').replace(/\/+/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      segments.pop();
      continue;
    }
    segments.push(seg);
  }
  return segments.join('/').toLowerCase();
}

function containedIn(child: string, root: string): boolean {
  const c = normalize(child);
  const r = normalize(root);
  return c === r || c.startsWith(`${r}/`);
}

function pathArg(call: ToolCall): string | null {
  const a = call.args ?? {};
  for (const k of ['path', 'file', 'filePath', 'file_path', 'dir', 'cwd']) {
    const v = a[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

const ABS_PATH_RE = /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/;

/**
 * F1 修复：**包含判定前先把相对路径按 `cwd`（缺省 `projectRoot`）解析成绝对路径**。
 * 否则模型最常用的相对写法（`src/a.ts`）会被 `path_scope` 误拦（over-blocking）。
 * 纯字符串实现（不引 `node:path`，保留本模块的无 IO／可单测性）。
 */
export function resolvePathArgument(p: string, ctx: Pick<GateContext, 'cwd' | 'projectRoot'>): string {
  if (ABS_PATH_RE.test(p)) return collapsePath(p);
  const base = ctx.cwd ?? ctx.projectRoot;
  if (!base) return p;
  const b = base.replace(/[\\/]+$/, '');
  return collapsePath(`${b}/${p}`);
}

/** 去 `.`/`..` 与重复分隔符（**保大小写**，仅规范形态；不改判定语义）。 */
export function collapsePath(p: string): string {
  const s = p.replace(/\\/g, '/');
  const drive = /^[a-zA-Z]:/.exec(s)?.[0];
  const unixAbs = !drive && s.startsWith('/');
  const parts: string[] = [];
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length > (drive ? 1 : 0)) parts.pop();
      continue;
    }
    parts.push(seg);
  }
  const body = parts.join('/');
  return drive ? body : unixAbs ? `/${body}` : body;
}

function hasGrant(ctx: GateContext, rule: string, toolName?: string): boolean {
  const now = ctx.now ?? Date.now();
  return (ctx.policy?.grants ?? []).some(
    (g) =>
      g.rule === rule &&
      (g.expiresAt == null || g.expiresAt > now) &&
      // 最小范围：有 toolName 的 grant 只放行同名工具（批准 mcp_call 不得顺带放行 web/git_push）。
      (toolName == null || g.toolName == null || g.toolName === toolName),
  );
}

function matchesAny(patterns: string[] | undefined, text: string): string | null {
  for (const p of patterns ?? []) {
    try {
      if (new RegExp(p, 'i').test(text)) return p;
    } catch {
      if (text.toLowerCase().includes(p.toLowerCase())) return p;
    }
  }
  return null;
}

/** 命中即返回；`ask` 类先查 `grants`（批准后放行）——**规则键与 ask 的 `rule` 同名**，范围最小。 */
function askOrGrant(ctx: GateContext, rule: string, reason: string, toolName?: string): GateResult {
  if (hasGrant(ctx, rule, toolName)) {
    return { decision: 'allow', reason: `已授予 ${rule} 放行（${toolName ?? '任意工具'}）`, rule: `grant:${rule}` };
  }
  return { decision: 'ask', reason, rule };
}

/** 三层判定；命中即返回对应决定。 */
export function permissionGate(call: ToolCall, ctx: GateContext): GateResult {
  const category = toolCategory(call.name);
  const effectiveAutonomy = downgradeAutonomy(ctx.autonomy, ctx.riskLevel);
  const required = CATEGORY_MIN_TIER[category];

  // ① 工具层（能力档）
  if (TIER_RANK[ctx.capabilityTier] < TIER_RANK[required]) {
    return { decision: 'deny', reason: `能力档 ${ctx.capabilityTier} 不允许 ${category} 类工具（需 ${required}）`, rule: 'capability_tier' };
  }

  // ② 动作层（consent）—— 对外/花钱/安装/危险命令**永不自动放行**（但**显式批准后**可按规则放行）
  if (category === 'external') {
    // 兼容既有 grant 规则名 `external`，并支持按 ask 规则名 `consent:external` 授与。
    if (hasGrant(ctx, 'external', call.name) || hasGrant(ctx, 'consent:external', call.name)) {
      return { decision: 'allow', reason: `已授予 ${call.name} 的 external 放行`, rule: 'grant:external' };
    }
    return askOrGrant(ctx, 'consent:external', '对外动作必须逐次批准（任何放行档都不自动放行）', call.name);
  }
  if (category === 'spend') {
    return askOrGrant(ctx, 'consent:spend', '花钱动作必须逐次批准', call.name);
  }
  if (category === 'install') {
    return askOrGrant(ctx, 'consent:install', '安装系统级依赖必须逐次批准', call.name);
  }

  const commandText = category === 'command' ? JSON.stringify(call.args ?? {}) : '';
  const rawCommand =
    category === 'command'
      ? String(
          (call.args as { command?: unknown; cmd?: unknown } | undefined)?.command ??
            (call.args as { cmd?: unknown } | undefined)?.cmd ??
            '',
        )
      : '';

  // ③ 命令黑名单 / 危险命令
  if (category === 'command') {
    // P3：先做命令语义预检（拆 bash -c / python -c / cmd /c 包裹；默认 deny/ask 规则可分发）。
    const precheck = precheckCommand(call);
    if (precheck) {
      if (precheck.decision === 'ask' && precheck.rule && hasGrant(ctx, precheck.rule, call.name)) {
        return { decision: 'allow', reason: `已授予 ${precheck.rule} 放行`, rule: `grant:${precheck.rule}` };
      }
      return precheck;
    }
    // B0-9：网络外发命令族→ask（在 denylist/consentRules 之前，任何放行档都不自动放行）。
    const egress = detectEgressCommand(rawCommand);
    if (egress) {
      return askOrGrant(ctx, 'consent:egress', `网络外发命令需逐次批准（${egress}）：${rawCommand.slice(0, 160)}`, call.name);
    }
    const denied = matchesAny(ctx.policy?.commandDenylist, commandText);
    if (denied) return { decision: 'deny', reason: `命令命中黑名单：${denied}`, rule: 'command_denylist' };
    const consent = matchesAny(ctx.policy?.consentRules, commandText);
    if (consent) return askOrGrant(ctx, 'consent:command', `命令需逐次批准：${consent}`, call.name);
  }

  // ③b MP1-F19：只读命令快速通道——白名单＋保守解析＋路径圈在授权根内，三关全过才放行
  //（写边界理念：边界管写不管读；读也可能外泄，故同样圈根。任何疑点回落下方原有门禁，不兜底放行）。
  if (category === 'command') {
    if (rawCommand.length > 0 && isReadOnlyBashCommand(rawCommand, { projectRoot: ctx.projectRoot, cwd: ctx.cwd })) {
      return { decision: 'allow', reason: '只读命令快速通道（白名单＋授权根内）', rule: 'readonly_command' };
    }
  }

  // ④ 路径层（只在读/写类工具且带路径参数时）
  if (category === 'read' || category === 'write') {
    const raw = pathArg(call);
    if (raw) {
      // F1：相对路径先按 cwd/projectRoot 解析成绝对，再做包含/敏感判定。
      const p = resolvePathArgument(raw, ctx);
      const low = p.toLowerCase().replace(/\\/g, '/');
      const rawLow = raw.toLowerCase().replace(/\\/g, '/');
      const sens = SENSITIVE.find((s) => low.includes(s) || rawLow.includes(s));
      if (sens && !hasGrant(ctx, 'sensitive', call.name)) {
        return { decision: 'deny', reason: `敏感路径默认拒绝：${sens}`, rule: 'sensitive_path' };
      }
      const deniedPrefix = matchesAny(ctx.policy?.pathDeny, p) ?? matchesAny(ctx.policy?.pathDeny, raw);
      if (deniedPrefix) return { decision: 'deny', reason: `路径命中拒绝规则：${deniedPrefix}`, rule: 'path_deny' };
      const inRoot = containedIn(p, ctx.projectRoot) || (ctx.cwd != null && containedIn(p, ctx.cwd));
      const allowedByPolicy = (ctx.policy?.pathAllow ?? []).some((pre) => containedIn(p, pre));
      if (!inRoot && !allowedByPolicy) {
        return { decision: 'deny', reason: '路径在项目根/工作目录之外（默认拒绝）', rule: 'path_scope' };
      }
    }
  }

  // ⑤ 放行档（写/命令等本地操作）
  if (category === 'write' || category === 'command') {
    if (effectiveAutonomy === 'strict') {
      // D-19 P1：strict 的询问同样查 grant——否则频道助手批准一次后仍会无限重复问。
      return askOrGrant(ctx, 'autonomy:strict', `放行档 strict：${category} 需逐次批准`, call.name);
    }
    return { decision: 'allow', reason: `放行档 ${effectiveAutonomy}：本地 ${category} 放行`, rule: `autonomy:${effectiveAutonomy}` };
  }

  return { decision: 'allow', reason: `只读/管理类工具放行（${category}）`, rule: 'readonly' };
}
