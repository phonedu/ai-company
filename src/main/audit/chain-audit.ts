/**
 * `chain-audit.ts` —— 功能链条断点审计（`pnpm audit:chain`）的**纯逻辑**（无 IO，可内存测）。
 *
 * 缘起（2026-10-15「第一步」令）：`docs/work/research-feature-chain-gap.md`（`C4` 批）的人肉审计
 * 已到天花板——`–` 全是「行在、生产者/执行方缺」类接缝断线，而 `test/doc-consistency.test.ts`
 * （`g-10-1`）只锁「文档↔代码逐行一致」，看不见**接线存在性**。本件把该件 §6「复跑配方」＋五类孤儿探测
 * 机器化，把「判不准」变成「跑一下」（判据对象＝代码差集，随功能增长自动重算）：
 *
 *   ① 孤儿迁移：状态机每个 `event` 的生产者（字面量 ＋ UI 表 `implemented:true` 透传）＝0 ⇒ 孤儿；
 *   ② 非法派发：dispatch 调用点的 `(scope,event)` 不在真值表 ⇒ 断链本体（``/`` 的签名）；
 *   ③ 孤儿写者：约定函数（如 `task_deps` 写者）的调用者仅测试 ⇒ 孤儿（`` 的签名）；
 *   ④ 孤儿工具：员工工具在 `employee-executor`（员工会话侧）消费＝0 ⇒ 孤儿（`` 的签名）；
 *   ⑤ 孤儿 timer：`TimerKind` 联合类型内、全仓无调度/处理引用 ⇒ 孤儿（`heartbeat_timeout`/cron 的签名）；
 *   ⑥ 孤儿动作：迁移 `actions()` 产出的 `kind` 无消费者 ⇒ 孤儿（未来防护；`` 近邻）；
 *   ⑦ 推送三腿：`evt:*` 通道 ×（声明/推送/路由）三腿对账 ⇒ 缺腿＝孤儿（`` 的签名）。
 *
 * 口径（v1，如实登记）：
 *  - 生产源 ＝ `src/main`＋`src/preload` 的**整行非注释**字面量 `event: 'X'` ＋ UI 表 `implemented:true` 条目；
 *  - 事件普查**按事件名**（不按 scope 分开）——`retry` 等两机同名事件算一个；scope 维度只留在②；
 *  - 孤儿动作（⑥）：`actions()` 以 **dummy ctx 执行**收集 `kind`（条件分支由字面量 `act('K'` 兜底，
 *    取并集；执行抛错的行如实登记为 failures）＋消费者＝字面量或 `action.kind.startsWith('P')` 族处理器；
 *  - 推送三腿（⑦）：preload `EVENT_CHANNELS` 声明 ↔ 主进程 `push('evt:X'` 站点 ↔ 渲染
 *    `channel === 'evt:X'` 路由——声明了零推送＝孤儿（``）；推了未声明＝反向孤儿；
 *    `evt:batch` 是信封传输层（`evt-sink` 恒推送），不参与对账；
 *  - UI 入口 × 状态交叉已有 `test/task-actions.test.ts`（对照 `m0:true` 行）承担，本件不重复；
 *  - 探针读数 ＝ 作用域内（整行注释与 `src/main/audit/` 自身除外）正则命中行数；
 *    账本偏移语义：`fixed` ⇒ 回归（红）、`open` ⇒ 待复核（黄）。
 */

export type OrphanCheck = 'event' | 'invalid-dispatch' | 'writer' | 'tool' | 'timer-kind' | 'action' | 'ipc-push';
export type DispositionStatus = 'open' | 'fixed' | 'intended';
export type MachineScope = 'task' | 'work_item';

export interface SourceFile {
  /** 仓库相对路径（`/` 分隔）。 */
  path: string;
  text: string;
}

export interface ProducerHit {
  path: string;
  line: number;
}

export interface TransitionLike {
  from: unknown;
  event: string;
  m0?: boolean;
  /** 迁移动作闭包（⑥ 以 dummy ctx 执行收集 kind；类型保持宽口径，审计模块不依赖引擎类型）。 */
  actions?: unknown;
}

export interface EventDef {
  scope: MachineScope;
  event: string;
  m0: boolean;
}

export interface EventCensus {
  event: string;
  scopes: MachineScope[];
  m0: boolean;
  hits: ProducerHit[];
  viaUiTable: boolean;
  producers: number;
}

export interface DispatchSite {
  path: string;
  line: number;
  scope: MachineScope;
  event: string;
}

export interface OrphanFinding {
  check: OrphanCheck;
  name: string;
  detail: string;
}

export interface Disposition {
  check: OrphanCheck;
  name: string;
  status: DispositionStatus;
  /** 证据/决定指针（BRK 编号、决定 id、工单名）。 */
  ref: string;
  note: string;
}

export interface Probe {
  id: string;
  /** `fixed` ＝ 修复锚（偏移即回归，红）；`open` ＝ 断点签名/现状锚（偏移待复核，黄）。 */
  status: 'open' | 'fixed';
  /** 作用域：文件或目录（仓库相对，`/` 分隔）。 */
  scope: string;
  /** 正则（逐行匹配）。 */
  pattern: string;
  op: '>=' | '==' | '<=';
  value: number;
  note: string;
}

export interface ProbeResult {
  probe: Probe;
  reading: number;
  ok: boolean;
}

export interface Reconciliation {
  known: OrphanFinding[];
  unknown: OrphanFinding[];
  regressions: OrphanFinding[];
  possiblyFixed: Disposition[];
}

export interface AuditSummary {
  red: boolean;
  redReasons: string[];
  yellowReasons: string[];
}

export interface WriterSpec {
  file: string;
  fn: string;
}

export interface ToolSpec {
  name: string;
  /** 消费者文件（员工会话侧；幕僚长 assistant 不算——`` 口径）。 */
  consumer: string;
  /** 可选：消费者侧的非字面量接线（工厂函数/变量名），如 `createLoadSkillTool|loadSkill`。 */
  consumerPattern?: string;
}

// ───────────────────────────── 扫描口径 ─────────────────────────────

const COMMENT_RE = /^\s*(\/\/|\/\*|\*)/;

/** 整行注释（`//`、`/*`、`*` 开头）——所有字面量扫描一律排除，防注释里的配方样文被计为读数。 */
export function isCommentLine(line: string): boolean {
  return COMMENT_RE.test(line);
}

/** 审计扫描域排除项（statemachine 是数据表不是生产者；本件自身防自吞）。 */
export function auditScanExcluded(path: string): boolean {
  return path.endsWith('engine/statemachine.ts') || path.startsWith('src/main/audit/');
}

/** 审计/账本**自身目录**（各探测默认排除；防自吞——账本里的字符串/探针样文不得被当读数）。 */
export function auditSelfExcluded(path: string): boolean {
  return path.startsWith('src/main/audit/');
}

/** UI 表 `implemented:true` 的事件集合（renderer 侧经 `task:transition` 透传，算生产者）。 */
export function uiImplementedEvents(
  table: Record<string, ReadonlyArray<{ event: string | null; implemented: boolean }>>,
): Set<string> {
  const out = new Set<string>();
  for (const entries of Object.values(table)) {
    for (const entry of entries) {
      if (entry.implemented === true && typeof entry.event === 'string') out.add(entry.event);
    }
  }
  return out;
}

const EVENT_LITERAL_RE = /event:\s*['"]([a-z_0-9]+)['"]/g;

/** 扫出「事件生产源」字面量：整行非注释的 `event: 'X'`。 */
export function collectEventLiterals(
  files: readonly SourceFile[],
  isExcluded: (path: string) => boolean = () => false,
): Map<string, ProducerHit[]> {
  const out = new Map<string, ProducerHit[]>();
  for (const file of files) {
    if (isExcluded(file.path)) continue;
    const lines = file.text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (isCommentLine(line)) continue;
      EVENT_LITERAL_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = EVENT_LITERAL_RE.exec(line)) !== null) {
        const name = m[1];
        if (!name) continue;
        const arr = out.get(name) ?? [];
        arr.push({ path: file.path, line: i + 1 });
        out.set(name, arr);
      }
    }
  }
  return out;
}

// ───────────────────────────── ① 孤儿迁移 ─────────────────────────────

export function eventDefs(
  taskRows: readonly TransitionLike[],
  wiRows: readonly TransitionLike[],
): EventDef[] {
  const out: EventDef[] = [];
  const add = (scope: MachineScope, rows: readonly TransitionLike[]): void => {
    for (const row of rows) {
      const existing = out.find((d) => d.scope === scope && d.event === row.event);
      if (existing) {
        existing.m0 = existing.m0 || row.m0 === true;
        continue;
      }
      out.push({ scope, event: row.event, m0: row.m0 === true });
    }
  };
  add('task', taskRows);
  add('work_item', wiRows);
  return out;
}

export function censusEvents(
  defs: readonly EventDef[],
  files: readonly SourceFile[],
  uiEvents: ReadonlySet<string>,
  isExcluded: (path: string) => boolean = () => false,
): EventCensus[] {
  const literals = collectEventLiterals(files, isExcluded);
  const out: EventCensus[] = [];
  for (const def of defs) {
    const existing = out.find((c) => c.event === def.event);
    if (existing) {
      if (!existing.scopes.includes(def.scope)) existing.scopes.push(def.scope);
      existing.m0 = existing.m0 || def.m0;
      continue;
    }
    const hits = literals.get(def.event) ?? [];
    const viaUiTable = uiEvents.has(def.event);
    out.push({
      event: def.event,
      scopes: [def.scope],
      m0: def.m0,
      hits,
      viaUiTable,
      producers: hits.length + (viaUiTable ? 1 : 0),
    });
  }
  return out;
}

export function orphanEventFindings(census: readonly EventCensus[]): OrphanFinding[] {
  return census
    .filter((c) => c.producers === 0)
    .map((c) => ({
      check: 'event' as const,
      name: c.event,
      detail: `0 生产者（${c.scopes.join('/')} 机${c.m0 ? ' · 含 M0 行' : ''}；字面量 0、UI 表未透传）`,
    }));
}

// ───────────────────────────── ② 非法派发 ─────────────────────────────

const DISPATCH_MARKER_RE = /(?:^|[^\w])dispatch\??\.?\s*\(|enqueue\s*\(|applyTaskEventInTx\s*\(/;

/** 收集 dispatch 调用点的 `(scope,event)`（字面量；marker 行起始，向后扫 8 行窗口）。 */
export function collectDispatchSites(
  files: readonly SourceFile[],
  isExcluded: (path: string) => boolean = () => false,
): DispatchSite[] {
  const out: DispatchSite[] = [];
  for (const file of files) {
    if (isExcluded(file.path)) continue;
    const lines = file.text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (isCommentLine(line)) continue;
      if (!DISPATCH_MARKER_RE.test(line)) continue;
      const window = lines
        .slice(i, Math.min(i + 8, lines.length))
        .filter((l) => !isCommentLine(l))
        .join('\n');
      const scope = /scope:\s*'(task|work_item)'/.exec(window)?.[1];
      const event = /event:\s*'([a-z_0-9]+)'/.exec(window)?.[1];
      if (!scope || !event) continue;
      out.push({ path: file.path, line: i + 1, scope: scope as MachineScope, event });
    }
  }
  return out;
}

export function invalidDispatchFindings(
  sites: readonly DispatchSite[],
  validPairs: ReadonlySet<string>,
): OrphanFinding[] {
  const grouped = new Map<string, DispatchSite[]>();
  for (const site of sites) {
    const key = `${site.scope}:${site.event}`;
    if (validPairs.has(key)) continue;
    const arr = grouped.get(key) ?? [];
    arr.push(site);
    grouped.set(key, arr);
  }
  return [...grouped.entries()].map(([key, list]) => {
    const first = list[0] as DispatchSite;
    return {
      check: 'invalid-dispatch' as const,
      name: key,
      detail: `非法派发 ×${list.length}（真值表无此迁移；首处 ${first.path}:${first.line}）`,
    };
  });
}

// ───────────────────────────── ③ 孤儿写者 ─────────────────────────────

export function writerFindings(
  files: readonly SourceFile[],
  specs: readonly WriterSpec[],
  isExcluded: (path: string) => boolean = auditSelfExcluded,
): OrphanFinding[] {
  const out: OrphanFinding[] = [];
  for (const spec of specs) {
    const re = new RegExp(`(?:^|[^\\w.])${spec.fn}\\s*\\(`);
    let callers = 0;
    for (const file of files) {
      if (file.path === spec.file || isExcluded(file.path)) continue;
      for (const line of file.text.split('\n')) {
        if (isCommentLine(line)) continue;
        if (re.test(line)) callers += 1;
      }
    }
    if (callers === 0) {
      out.push({
        check: 'writer',
        name: `${spec.file}:${spec.fn}`,
        detail: '零调用者（扫描域＝src/main＋src/preload；测试/再导出不计）',
      });
    }
  }
  return out;
}

// ───────────────────────────── ④ 孤儿工具 ─────────────────────────────

export function toolFindings(
  files: readonly SourceFile[],
  specs: readonly ToolSpec[],
  isExcluded: (path: string) => boolean = auditSelfExcluded,
): OrphanFinding[] {
  const out: OrphanFinding[] = [];
  for (const spec of specs) {
    const file = files.find((f) => f.path === spec.consumer && !isExcluded(f.path));
    let consumers = 0;
    if (file) {
      const re = spec.consumerPattern
        ? new RegExp(spec.consumerPattern)
        : new RegExp(`(?:\\.name|toolName)\\s*===\\s*['"]${spec.name}['"]`);
      for (const line of file.text.split('\n')) {
        if (isCommentLine(line)) continue;
        if (re.test(line)) consumers += 1;
      }
    }
    if (consumers === 0) {
      out.push({ check: 'tool', name: spec.name, detail: `员工会话侧（${spec.consumer}）零消费者` });
    }
  }
  return out;
}

// ───────────────────────────── ⑤ 孤儿 timer ─────────────────────────────

export function timerKindFindings(
  files: readonly SourceFile[],
  kinds: readonly string[],
  isExcluded: (path: string) => boolean = auditSelfExcluded,
): OrphanFinding[] {
  const out: OrphanFinding[] = [];
  for (const kind of kinds) {
    const re = new RegExp(`['"]${kind}['"]`);
    let hits = 0;
    for (const file of files) {
      if (isExcluded(file.path)) continue;
      for (const line of file.text.split('\n')) {
        if (isCommentLine(line)) continue;
        if (/export type TimerKind/.test(line)) continue;
        if (re.test(line)) hits += 1;
      }
    }
    if (hits === 0) {
      out.push({ check: 'timer-kind', name: kind, detail: 'TimerKind 联合类型内、全仓无调度/处理引用' });
    }
  }
  return out;
}

// ───────────────────────────── ⑥ 孤儿动作 ─────────────────────────────

/** dummy 上下文：仅够动作闭包构造 EngineAction（读 payload 的派生动作会走空分支，由字面量扫描兜底）。 */
const DUMMY_TASK_CTX: Record<string, unknown> = {
  taskId: 1,
  from: 'ready',
  now: 0,
  actor: 'system',
  riskLevel: 1,
  payload: {},
  resumeState: null,
  stateBeforeClose: null,
  defaultAction: null,
};

export interface ActionResult {
  kinds: Map<string, string[]>;
  failures: Array<{ row: string; error: string }>;
}

/** 以 dummy ctx 逐行执行 `actions()`，收集产出的动作 `kind`（抛错的行如实登记）。 */
export function executeActionKinds(rows: readonly TransitionLike[], scope: MachineScope): ActionResult {
  const kinds = new Map<string, string[]>();
  const failures: Array<{ row: string; error: string }> = [];
  for (const row of rows) {
    if (typeof row.actions !== 'function') continue;
    const rowId = `${scope}:${row.event}`;
    try {
      const produced = (row.actions as (ctx: Record<string, unknown>) => unknown)(DUMMY_TASK_CTX);
      if (!Array.isArray(produced)) continue;
      for (const item of produced) {
        const kind = (item as { kind?: unknown } | null)?.kind;
        if (typeof kind !== 'string' || kind.length === 0) continue;
        const sources = kinds.get(kind) ?? [];
        if (!sources.includes(rowId)) sources.push(rowId);
        kinds.set(kind, sources);
      }
    } catch (error) {
      failures.push({ row: rowId, error: String(error) });
    }
  }
  return { kinds, failures };
}

/** 字面量兜底：`act('K'`（条件分支路径执行不出的 kind 由此补齐）。 */
export function literalActionKinds(statemachineText: string): string[] {
  const out = new Set<string>();
  const re = /act\(\s*['"]([a-z_0-9]+)['"]/g;
  for (const line of statemachineText.split('\n')) {
    if (isCommentLine(line)) continue;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) if (m[1]) out.add(m[1]);
  }
  return [...out];
}

export interface ActionKindCensus {
  kind: string;
  sources: string[];
  /** 由字面量扫描兜到（执行未产出，如条件分支）。 */
  viaLiteral: boolean;
}

export function actionKindCensus(
  executions: readonly ActionResult[],
  literalKinds: readonly string[],
): ActionKindCensus[] {
  const byKind = new Map<string, ActionKindCensus>();
  for (const result of executions) {
    for (const [kind, sources] of result.kinds) {
      const entry = byKind.get(kind) ?? { kind, sources: [], viaLiteral: false };
      for (const source of sources) if (!entry.sources.includes(source)) entry.sources.push(source);
      byKind.set(kind, entry);
    }
  }
  for (const kind of literalKinds) {
    const entry = byKind.get(kind) ?? { kind, sources: [], viaLiteral: true };
    entry.viaLiteral = true;
    byKind.set(kind, entry);
  }
  return [...byKind.values()];
}

/** 消费者对账：字面量 `'K'` 或族处理器（`action.kind.startsWith('P')`）；皆无 ⇒ 孤儿。 */
export function actionKindFindings(
  census: readonly ActionKindCensus[],
  files: readonly SourceFile[],
  isExcluded: (path: string) => boolean = auditScanExcluded,
): OrphanFinding[] {
  const prefixes = new Set<string>();
  const prefixRe = /\.kind\.startsWith\(\s*'([a-z_]+)'\s*\)/g;
  for (const file of files) {
    if (isExcluded(file.path)) continue;
    for (const line of file.text.split('\n')) {
      if (isCommentLine(line)) continue;
      prefixRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = prefixRe.exec(line)) !== null) if (m[1]) prefixes.add(m[1]);
    }
  }
  const out: OrphanFinding[] = [];
  for (const entry of census) {
    const literalRe = new RegExp(`['"]${entry.kind}['"]`);
    let consumers = 0;
    for (const file of files) {
      if (isExcluded(file.path)) continue;
      for (const line of file.text.split('\n')) {
        if (isCommentLine(line)) continue;
        if (literalRe.test(line)) consumers += 1;
      }
    }
    const family = [...prefixes].find((p) => entry.kind.startsWith(p)) ?? null;
    if (consumers === 0 && family === null) {
      const source = entry.sources.length > 0 ? entry.sources.join(', ') : `字面量 act('${entry.kind}'`;
      out.push({
        check: 'action',
        name: entry.kind,
        detail: `0 消费者（字面量与族处理器均未覆盖）· 来源 ${source}`,
      });
    }
  }
  return out;
}

// ───────────────────────────── ⑦ 推送三腿 ─────────────────────────────

export interface PushChainCensus {
  /** preload `EVENT_CHANNELS` 声明。 */
  declared: string[];
  /** 主进程 `push('evt:X'` 站点。 */
  pushed: string[];
  /** 渲染侧 `channel === 'evt:X'` 路由。 */
  routed: string[];
}

export function pushChainCensus(files: readonly SourceFile[]): PushChainCensus {
  const declared: string[] = [];
  const pushed = new Set<string>();
  const routed = new Set<string>();
  for (const file of files) {
    if (file.path === 'src/preload/index.ts') {
      const block = /EVENT_CHANNELS\s*=\s*\[([^\]]*)\]/.exec(file.text)?.[1] ?? '';
      for (const m of block.matchAll(/'(evt:[a-z-]+)'/g)) if (m[1]) declared.push(m[1]);
    }
    if (file.path.startsWith('src/main/')) {
      for (const line of file.text.split('\n')) {
        if (isCommentLine(line)) continue;
        for (const m of line.matchAll(/push\(\s*'(evt:[a-z-]+)'/g)) if (m[1]) pushed.add(m[1]);
      }
    }
    if (file.path.startsWith('src/renderer/')) {
      for (const line of file.text.split('\n')) {
        if (isCommentLine(line)) continue;
        for (const m of line.matchAll(/channel\s*===\s*'(evt:[a-z-]+)'/g)) if (m[1]) routed.add(m[1]);
      }
    }
  }
  return { declared, pushed: [...pushed], routed: [...routed] };
}

export function ipcPushFindings(files: readonly SourceFile[]): OrphanFinding[] {
  const { declared, pushed, routed } = pushChainCensus(files);
  const out: OrphanFinding[] = [];
  for (const channel of declared) {
    if (channel === 'evt:batch') continue; // 信封传输层（evt-sink 恒推送），不作内容通道对账
    if (!pushed.includes(channel)) {
      out.push({
        check: 'ipc-push',
        name: channel,
        detail: `preload 已声明；主进程推送 0 · 渲染路由 ${routed.includes(channel) ? '已在' : '缺'}`,
      });
    }
  }
  const declaredSet = new Set(declared);
  for (const channel of pushed) {
    if (channel === 'evt:batch' || declaredSet.has(channel)) continue;
    out.push({
      check: 'ipc-push',
      name: `${channel}（未声明）`,
      detail: `主进程推送 ≥1 · 渲染路由 ${routed.includes(channel) ? '已在' : '缺'}；不在 preload EVENT_CHANNELS 白名单`,
    });
  }
  return out;
}

// ───────────────────────────── 探针与对账 ─────────────────────────────

export function runProbes(
  probes: readonly Probe[],
  files: readonly SourceFile[],
  isExcluded: (path: string) => boolean = auditSelfExcluded,
): ProbeResult[] {
  return probes.map((probe) => {
    const scopeDir = probe.scope.replace(/\/+$/, '');
    const scoped = files.filter(
      (f) => !isExcluded(f.path) && (f.path === scopeDir || f.path.startsWith(`${scopeDir}/`)),
    );
    const re = new RegExp(probe.pattern);
    let reading = 0;
    for (const file of scoped) {
      for (const line of file.text.split('\n')) {
        if (isCommentLine(line)) continue;
        if (re.test(line)) reading += 1;
      }
    }
    const ok =
      probe.op === '>=' ? reading >= probe.value : probe.op === '<=' ? reading <= probe.value : reading === probe.value;
    return { probe, reading, ok };
  });
}

export function reconcile(
  findings: readonly OrphanFinding[],
  dispositions: readonly Disposition[],
): Reconciliation {
  const byKey = new Map(dispositions.map((d) => [`${d.check}:${d.name}`, d]));
  const known: OrphanFinding[] = [];
  const unknown: OrphanFinding[] = [];
  const regressions: OrphanFinding[] = [];
  for (const finding of findings) {
    const disposition = byKey.get(`${finding.check}:${finding.name}`);
    if (!disposition) unknown.push(finding);
    else if (disposition.status === 'fixed') regressions.push(finding);
    else known.push(finding);
  }
  const findingKeys = new Set(findings.map((f) => `${f.check}:${f.name}`));
  const possiblyFixed = dispositions.filter(
    (d) => d.status === 'open' && !findingKeys.has(`${d.check}:${d.name}`),
  );
  return { known, unknown, regressions, possiblyFixed };
}

export function summarize(recon: Reconciliation, probeResults: readonly ProbeResult[]): AuditSummary {
  const redReasons: string[] = [];
  const yellowReasons: string[] = [];
  for (const f of recon.unknown) redReasons.push(`新孤儿（未登记）：${f.check}:${f.name}`);
  for (const f of recon.regressions) redReasons.push(`回归（账本已标 fixed，读数仍为断）：${f.check}:${f.name}`);
  for (const d of recon.possiblyFixed) yellowReasons.push(`账本待更新（open 但孤儿已消失）：${d.check}:${d.name}`);
  for (const p of probeResults) {
    if (p.ok) continue;
    const line = `探针偏移：${p.probe.id}（读数 ${p.reading}，期望 ${p.probe.op}${p.probe.value}）`;
    if (p.probe.status === 'fixed') redReasons.push(`回归＝${line}`);
    else yellowReasons.push(line);
  }
  return { red: redReasons.length > 0, redReasons, yellowReasons };
}
