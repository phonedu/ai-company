/**
 * 「公司大厅」主进程侧装配（M1 B0/B1 · 简单版公司布局）。
 *
 * 老板口径：① **轻量部门**（**零迁移**配置，先固定三部门、后期可改）；② **不显示负责人**
 * （配置预留可选 `leadEmployeeId`）；③ 部门间协作**只用真实流向**（由 `work_items` 序列聚合，
 * **无往来不画边**；不做可编辑协作文本）。
 *
 * 配置选型：**零迁移的模块内常量**（本文件）——最简单、无需 settings DAO/迁移；后期要「运行时可改」
 * 再升级为 `settings.org.layout`（接口 `HallStateDTO` 不变）。
 */
import { listEmployees } from '../db/employees.js';
import type { SqliteDb } from '../db/open.js';

export interface DepartmentConfig {
  id: string;
  name: string;
  /** 预留：负责人（老板口径 ②：**当前不展示**）。 */
  leadEmployeeId?: number | null;
}

/** 轻量部门（先三个；后期改这里即可）。 */
export const ORG_DEPARTMENTS: DepartmentConfig[] = [
  { id: 'product', name: '产品部', leadEmployeeId: null },
  { id: 'engineering', name: '研发部', leadEmployeeId: null },
  { id: 'operations', name: '运营部', leadEmployeeId: null },
];

/** 员工 **id** → 部门 id 归属（**按 id**：名字会改、id 不变；未命中 → 「未分组」）。后期可改此表。 */
export const ORG_MEMBERSHIP: Record<number, string> = {
  // 轻量部门的**引导映射**（与 demo roster 对齐；截图用 id 1..5）。后期改这里即可。
  1: 'product', // 产品负责人
  2: 'engineering', // 技术负责人
  3: 'operations', // 运营负责人
  4: 'operations', // 内容运营
  5: 'engineering', // 数据分析
  // 0 号（幕僚长）不填 → 落「未分组」（`UI §6.1` 它也在墙上）。
};

export const UNGROUPED_ID = 'ungrouped';
export const UNGROUPED_NAME = '未分组';

export interface EmployeeDTO {
  id: number;
  name: string;
  role: string;
  avatar: string | null;
  isAssistant: boolean;
  active: boolean;
  departmentId: string;
  /** 2026-10-16（大厅批）员工卡读数——见 `EmployeeActivity`。 */
  activity?: EmployeeActivity;
  /** GAP6：MCP 分配 refs（id 或名字；设置·MCP 分配矩阵只读用）。 */
  mcpRefs?: string[];
}

/**
 * 员工级「今日活动」聚合（2026-10-16 大厅批·施工前置件）：员工卡的
 * 状态点 / 当前动作 / 今日产出 / 今日时长——全部由 `work_items`／`tasks`／`reports` **真数据**得出；
 * 无数据如实 `0`（**有源的 0**）与 `null`（不猜、不摆假动作）。
 */
export interface EmployeeActivity {
  /**
   * 思考中＝有 running 件（任务不在等待态）；等你＝running 件的任务在等待老板；
   * 卡住了＝最近一件 failed/interrupted 且任务未结束；空闲＝其余。
   */
  status: 'running' | 'waiting' | 'idle' | 'stuck';
  /** 当前动作人话（waiting＝「等你裁定/等你批准：…」；running＝件标题；stuck＝「卡住/中断：…」；idle＝「上一件：…」）。 */
  currentAction: string | null;
  /** 当前/上一件所属任务短号（无 ⇒ null）。 */
  taskShortId: string | null;
  /** 当前/上一件所属任务 id（可点进任务详情；无 ⇒ null）。 */
  taskId: number | null;
  /** 当前件已运行分钟数（running/waiting 才有；其余 0）。 */
  currentMinutes: number;
  /** 今日完成件数（有源的 0 如实显 0）。 */
  todayOutput: number;
  /** 今日时长（分钟；已完成件 `started→finished` 合计；缺数据按 0）。 */
  todayMinutes: number;
  /** 今日登记产物数（artifacts.created_at 落在今日；0 是有源的 0）。 */
  todayArtifacts: number;
}

/** 任务态 → 「在等老板」判定（大厅「等你」点；与引擎状态机同口径，不自造状态）。 */
const WAITING_TASK_STATES: ReadonlySet<string> = new Set(['needs_decision', 'awaiting_approval', 'blocked', 'paused']);

/** 本地日零点（今日产出/时长的时间窗）。 */
function startOfToday(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** 员工级今日活动聚合（见 `EmployeeActivity`；全部真读数）。 */
function buildEmployeeActivity(db: SqliteDb, now: number): Map<number, EmployeeActivity> {
  const since = startOfToday(now);
  const out = new Map<number, EmployeeActivity>();
  const blank = (): EmployeeActivity => ({
    status: 'idle',
    currentAction: null,
    taskShortId: null,
    taskId: null,
    currentMinutes: 0,
    todayOutput: 0,
    todayMinutes: 0,
    todayArtifacts: 0,
  });
  const put = (employeeId: number, patch: Partial<EmployeeActivity>): void => {
    const prev = out.get(employeeId) ?? blank();
    out.set(employeeId, { ...prev, ...patch });
  };

  // ① running 件（含任务态/短号/开始时间）——「思考中 / 等你」两态与当前动作的来源。
  const running = db
    .prepare(
      `SELECT wi.employee_id AS employee_id, wi.title AS title, wi.task_id AS task_id,
              wi.started_at AS started_at, t.state AS task_state, t.short_id AS short_id
         FROM work_items wi JOIN tasks t ON t.id = wi.task_id
        WHERE wi.state = 'running'`,
    )
    .all() as Array<{
    employee_id: number;
    title: string;
    task_id: number;
    started_at: number | null;
    task_state: string;
    short_id: string | null;
  }>;
  // ② 该任务的未结决策卡（「等你裁定：<问题>」的人话来源）。
  const pendingAsks = new Map<number, string>();
  for (const row of db
    .prepare(`SELECT task_id, payload FROM reports WHERE kind = 'ask' AND state = 'pending'`)
    .all() as Array<{ task_id: number | null; payload: string }>) {
    if (row.task_id == null) continue;
    try {
      const payload = JSON.parse(row.payload) as { question?: unknown };
      if (typeof payload.question === 'string' && payload.question.length > 0) pendingAsks.set(row.task_id, payload.question);
    } catch {
      // 载荷不可解析 → 回落件标题（不静默、不臆造问题文本）。
    }
  }
  for (const row of running) {
    const waiting = WAITING_TASK_STATES.has(row.task_state);
    const prefix = row.task_state === 'awaiting_approval' ? '等你批准：' : '等你裁定：';
    put(row.employee_id, {
      status: waiting ? 'waiting' : 'running',
      currentAction: waiting ? `${prefix}${pendingAsks.get(row.task_id) ?? row.title}` : row.title,
      taskShortId: row.short_id,
      taskId: row.task_id,
      currentMinutes:
        row.started_at != null ? Math.max(0, Math.round((now - row.started_at) / 60_000)) : 0,
    });
  }

  // ③ 无 running 且**最近一件**是失败/中断（任务未结束）→「卡住了」（红点；不把历史失败永远挂着）。
  const latestFault = db
    .prepare(
      `SELECT wi.employee_id AS employee_id, wi.title AS title, wi.state AS wi_state,
              t.id AS task_id, t.short_id AS short_id, t.state AS task_state
         FROM work_items wi JOIN tasks t ON t.id = wi.task_id
        WHERE wi.state IN ('failed', 'interrupted')
          AND t.state NOT IN ('done', 'cancelled', 'paused') AND t.archived = 0
          -- paused 是老板主动停的，不是“卡住了”（hall §6.1 四态不把人工暂停算故障）
          AND wi.id = (SELECT MAX(w2.id) FROM work_items w2 WHERE w2.employee_id = wi.employee_id)
        ORDER BY wi.id DESC`,
    )
    .all() as Array<{
    employee_id: number;
    title: string;
    wi_state: string;
    task_id: number;
    short_id: string | null;
    task_state: string;
  }>;
  for (const row of latestFault) {
    if (out.has(row.employee_id)) continue; // running/waiting 优先
    put(row.employee_id, {
      status: 'stuck',
      currentAction: `${row.wi_state === 'interrupted' ? '中断' : '卡住'}：${row.title}`,
      taskShortId: row.short_id,
      taskId: row.task_id,
    });
  }

  // ④ 无 running 的员工：最近一件（done/submitted）→「上一件：<题>」。
  const latest = db
    .prepare(
      `SELECT wi.employee_id AS employee_id, wi.title AS title, wi.task_id AS task_id, t.short_id AS short_id
         FROM work_items wi JOIN tasks t ON t.id = wi.task_id
        WHERE wi.state IN ('done', 'submitted') AND wi.finished_at IS NOT NULL
        ORDER BY wi.finished_at DESC, wi.id DESC`,
    )
    .all() as Array<{ employee_id: number; title: string; task_id: number; short_id: string | null }>;
  for (const row of latest) {
    const prev = out.get(row.employee_id);
    if (prev == null) {
      put(row.employee_id, {
        status: 'idle',
        currentAction: `上一件：${row.title}`,
        taskShortId: row.short_id,
        taskId: row.task_id,
      });
    }
  }

  // ⑤ 今日产出/时长（已完成件；started_at 缺 ⇒ 时长按 0 计入、件数照计）。
  const today = db
    .prepare(
      `SELECT employee_id,
              COUNT(*) AS n,
              COALESCE(SUM(CASE WHEN started_at IS NOT NULL THEN finished_at - started_at ELSE 0 END), 0) AS ms
         FROM work_items
        WHERE state = 'done' AND finished_at IS NOT NULL AND finished_at >= ?
        GROUP BY employee_id`,
    )
    .all(since) as Array<{ employee_id: number; n: number; ms: number }>;
  for (const row of today) {
    put(row.employee_id, { todayOutput: row.n, todayMinutes: Math.round(row.ms / 60_000) });
  }

  // ⑥ 今日产物数（按产出员工；无产物是 0，不是 null）。
  const artifacts = db
    .prepare(
      `SELECT wi.employee_id AS employee_id, COUNT(*) AS n
         FROM artifacts a JOIN work_items wi ON wi.id = a.work_item_id
        WHERE a.created_at >= ?
        GROUP BY wi.employee_id`,
    )
    .all(since) as Array<{ employee_id: number; n: number }>;
  for (const row of artifacts) {
    put(row.employee_id, { todayArtifacts: row.n });
  }

  // ⑦ UG-08（D4 must-fix）：**全员补齐真读数**——凡在册员工都过一遍（COUNT 本身是事实），
  //    不让「未出现在任何查询结果」的员工拿到 blank() 的无源 0；blank() 由此只在“确为 0”时产 0。
  const allEmployees = db.prepare('SELECT id FROM employees WHERE active = 1 OR id = 0').all() as Array<{ id: number }>;
  for (const { id } of allEmployees) {
    if (!out.has(id)) out.set(id, blank());
  }

  return out;
}

export interface DepartmentDTO {
  id: string;
  name: string;
  leadEmployeeId?: number | null;
  memberIds: number[];
}

/** 部门间真实协作流（`work_items` 相邻步骤跨部门时计一次；`count=0` 的边不产出）。 */
export interface CollabEdgeDTO {
  from: string;
  to: string;
  count: number;
}

/** 大厅「实时活动流」的一条（只读投影；来源＝`task_events`，不另造事件）。 */
export interface HallActivityDTO {
  id: number;
  ts: number;
  kind: string;
  actor: string;
  actorName: string;
  taskId: number;
  taskShortId: string | null;
  taskTitle: string | null;
  text: string;
  detail: string | null;
  tone: 'ok' | 'warn' | 'danger' | 'dim';
}

export interface HallStateDTO {
  employees: EmployeeDTO[];
  departments: DepartmentDTO[];
  /** 真实流向（契约名 `collab`）；`count` 为 `windowDays` 内的真实次数，**无往来不出现**。 */
  collab: CollabEdgeDTO[];
  /** 最近的公司活动流（`task_events` 只读投影；最多 20 条）。 */
  activityLog: HallActivityDTO[];
  windowDays: number;
}

function departmentOf(employeeId: number, membership: Record<number, string>): string {
  return membership[employeeId] ?? UNGROUPED_ID;
}

/** 真实流向：按任务把 `work_items`（`id` 升序 = 创建序）映射到部门，累计相邻**跨部门**的 from→to；同部门不算。 */
function buildCollaboration(db: SqliteDb, deptByEmployee: Map<number, string>, sinceMs: number): CollabEdgeDTO[] {
  const rows = db
    .prepare(`SELECT task_id, employee_id FROM work_items WHERE created_at >= ? ORDER BY task_id, id`)
    .all(sinceMs) as Array<{ task_id: number; employee_id: number }>;
  const perTask = new Map<number, string[]>();
  for (const row of rows) {
    const dept = deptByEmployee.get(row.employee_id);
    if (!dept || dept === UNGROUPED_ID) continue; // 未分组不参与协作图
    const seq = perTask.get(row.task_id) ?? [];
    seq.push(dept);
    perTask.set(row.task_id, seq);
  }
  const counts = new Map<string, number>();
  for (const seq of perTask.values()) {
    for (let i = 1; i < seq.length; i += 1) {
      const from = seq[i - 1];
      const to = seq[i];
      if (from === to) continue;
      const key = `${from}->${to}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([key, count]) => {
      const [from, to] = key.split('->');
      return { from, to, count };
    })
    .sort((a, b) => b.count - a.count);
}

/** 活动流收录的事件（只收“人事/任务进展”类；tool_call/thought 不上大厅）。 */
const HALL_ACTIVITY_KINDS = [
  'plan_drafted',
  'plan_edited',
  'plan_reviewed',
  'plan_approved',
  'task_started',
  'work_item_submitted',
  'verification_completed',
  'task_completed',
  'task_failed',
  'task_cancelled',
  'task_paused',
  'task_resumed',
  'changeset_created',
  'changeset_merged',
  'checkpoint_created',
  'work_item_rolled_back',
  'verification_invalidated',
  'budget_exceeded',
  'task_skill_forced',
  'task_renewed',
  'agent_model_fallback',
] as const;

interface ActivityRow {
  id: number;
  ts: number;
  kind: string;
  actor: string;
  task_id: number;
  short_id: string | null;
  title: string | null;
  payload: string;
}

function activityText(
  kind: string,
  payload: Record<string, unknown>,
  label: string,
): { text: string; detail: string | null; tone: HallActivityDTO['tone'] } {
  const notes = typeof payload.notes === 'string' && payload.notes.trim().length > 0 ? payload.notes.trim() : null;
  if (kind === 'plan_drafted') return { text: `提交计划：${label}`, detail: notes, tone: 'dim' };
  if (kind === 'plan_edited') return { text: `修改计划：${label}`, detail: notes, tone: 'warn' };
  if (kind === 'plan_reviewed') {
    const revise = payload.verdict === 'revise';
    return { text: `${revise ? '计划被打回' : '计划评审通过'}：${label}`, detail: notes, tone: revise ? 'warn' : 'ok' };
  }
  if (kind === 'plan_approved') return { text: `计划已批准：${label}`, detail: notes, tone: 'ok' };
  if (kind === 'task_started') return { text: `开始执行：${label}`, detail: null, tone: 'dim' };
  if (kind === 'work_item_submitted') return { text: `提交工作项：${label}`, detail: notes, tone: 'dim' };
  if (kind === 'verification_completed') {
    const pass = payload.verdict === 'pass';
    return { text: `${pass ? '验证通过' : '验证未通过'}：${label}`, detail: notes, tone: pass ? 'ok' : 'danger' };
  }
  if (kind === 'task_completed') return { text: `完成：${label}`, detail: notes, tone: 'ok' };
  if (kind === 'task_failed') return { text: `失败：${label}`, detail: notes, tone: 'danger' };
  if (kind === 'task_cancelled') return { text: `取消：${label}`, detail: notes, tone: 'danger' };
  if (kind === 'task_paused') return { text: `暂停：${label}`, detail: notes, tone: 'warn' };
  if (kind === 'task_resumed') return { text: `继续：${label}`, detail: notes, tone: 'dim' };
  if (kind === 'changeset_created') return { text: `生成变更集：${label}`, detail: null, tone: 'dim' };
  if (kind === 'changeset_merged') return { text: `变更已合并：${label}`, detail: null, tone: 'ok' };
  if (kind === 'checkpoint_created') return { text: `记录检查点：${label}`, detail: null, tone: 'dim' };
  if (kind === 'work_item_rolled_back') return { text: `工作项已回滚：${label}`, detail: notes, tone: 'warn' };
  if (kind === 'verification_invalidated') return { text: `验证结论已过期：${label}`, detail: notes, tone: 'warn' };
  if (kind === 'budget_exceeded') return { text: `超预算暂停：${label}`, detail: notes, tone: 'warn' };
  if (kind === 'task_skill_forced') return { text: `强制加载技能：${label}`, detail: notes, tone: 'dim' };
  if (kind === 'task_renewed') return { text: `续办任务：${label}`, detail: notes, tone: 'dim' };
  if (kind === 'agent_model_fallback') return { text: `模型降级：${label}`, detail: notes, tone: 'warn' };
  return { text: `${kind}：${label}`, detail: notes, tone: 'dim' };
}

/** 最近 20 条公司活动（事件唯一事实来源；演员名从在职员工表解析，查不到如实显示员工#id）。 */
function buildActivityLog(
  db: SqliteDb,
  employees: ReadonlyArray<{ id: number; name: string }>,
  limit = 20,
): HallActivityDTO[] {
  const placeholders = HALL_ACTIVITY_KINDS.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT e.id AS id, e.ts AS ts, e.kind AS kind, e.actor AS actor,
              e.task_id AS task_id, t.short_id AS short_id, t.title AS title, e.payload AS payload
         FROM task_events e LEFT JOIN tasks t ON t.id = e.task_id
        WHERE e.kind IN (${placeholders}) AND e.task_id IS NOT NULL
        ORDER BY e.ts DESC, e.id DESC
        LIMIT ?`,
    )
    .all(...HALL_ACTIVITY_KINDS, limit) as ActivityRow[];
  const names = new Map(employees.map((e) => [e.id, e.name]));
  return rows.map((row) => {
    let payload: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.payload) as unknown;
      if (parsed && typeof parsed === 'object') payload = parsed as Record<string, unknown>;
    } catch {
      // 载荷不可解析 ⇒ 只显示事件类型与任务标题（不编摘要）。
    }
    let actorName = row.actor;
    if (row.actor.startsWith('employee:')) {
      const id = Number(row.actor.slice('employee:'.length));
      actorName = names.get(id) ?? `员工#${id}`;
    } else if (row.actor === 'boss') {
      actorName = '你';
    } else if (row.actor === 'system') {
      actorName = '系统';
    }
    const label = row.title?.trim() || row.short_id || `#${row.task_id}`;
    const view = activityText(row.kind, payload, label);
    return {
      id: row.id,
      ts: row.ts,
      kind: row.kind,
      actor: row.actor,
      actorName,
      taskId: row.task_id,
      taskShortId: row.short_id,
      taskTitle: row.title,
      text: view.text,
      detail: view.detail,
      tone: view.tone,
    };
  });
}

export function buildHallState(
  db: SqliteDb,
  membership: Record<number, string> = ORG_MEMBERSHIP,
  options: { now?: number; windowDays?: number } = {},
): HallStateDTO {
  const windowDays = options.windowDays ?? 7;
  const now = options.now ?? Date.now();
  const sinceMs = now - windowDays * 24 * 60 * 60 * 1000;

  const rows = listEmployees(db);
  const activity = buildEmployeeActivity(db, now);
  const deptByEmployee = new Map<number, string>();
  const employees: EmployeeDTO[] = rows.map((row) => {
    const departmentId = departmentOf(row.id, membership);
    deptByEmployee.set(row.id, departmentId);
    return {
      id: row.id,
      name: row.name,
      role: row.role,
      avatar: row.avatar,
      isAssistant: row.is_assistant === 1,
      active: row.active === 1,
      departmentId,
      mcpRefs: (() => {
        try {
          const refs = JSON.parse(row.mcps ?? '[]') as unknown;
          return Array.isArray(refs) ? refs.map(String) : [];
        } catch {
          return [];
        }
      })(),
      activity:
        activity.get(row.id) ??
          ({
            status: 'idle',
            currentAction: null,
            taskShortId: null,
            taskId: null,
            currentMinutes: 0,
            todayOutput: 0,
            todayMinutes: 0,
            todayArtifacts: 0,
          } satisfies EmployeeActivity),
    };
  });

  const memberIdsByDept = new Map<string, number[]>();
  for (const employee of employees) {
    const ids = memberIdsByDept.get(employee.departmentId) ?? [];
    ids.push(employee.id);
    memberIdsByDept.set(employee.departmentId, ids);
  }

  const departments: DepartmentDTO[] = ORG_DEPARTMENTS.map((dept) => ({
    id: dept.id,
    name: dept.name,
    leadEmployeeId: dept.leadEmployeeId ?? null,
    memberIds: memberIdsByDept.get(dept.id) ?? [],
  }));
  const ungrouped = memberIdsByDept.get(UNGROUPED_ID) ?? [];
  if (ungrouped.length > 0) {
    departments.push({ id: UNGROUPED_ID, name: UNGROUPED_NAME, leadEmployeeId: null, memberIds: ungrouped });
  }

  return {
    employees,
    departments,
    collab: buildCollaboration(db, deptByEmployee, sinceMs),
    activityLog: buildActivityLog(db, employees, 20),
    windowDays,
  };
}
