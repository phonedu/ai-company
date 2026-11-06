/**
 * GenUI 卡片 schema（M1 最小版）—— 契约见 `docs/UI.md §4.7`（`CardSchema` 冻结）。
 *
 * 设计约束（安全三条）：
 *  1) **白名单组件 + 白名单 action**：只渲染受控组件、只接受受控意图，**绝不执行模型生成的 JS**；
 *  2) **来源标注**：`meta.generatedBy` → 卡片头 `card-provenance`；
 *  3) **危险动作不过卡片**：按钮只发 `{schemaId,componentId,action,payload}` 意图，主进程过 `permissionGate`。
 *
 * 本文件**零依赖**（手写校验，不引 zod 等）。
 */
export type GenUiProvenance = 'assistant' | 'employee' | 'external-echo';

export interface GenUiGeneratedBy {
  employeeId?: number;
  employeeName?: string;
  taskId?: number;
  taskShortId?: string;
}

export interface GenUiActionDef {
  key: string;
  label: string;
  variant?: 'primary' | 'ghost' | 'danger';
  recommended?: boolean;
  disabled?: boolean;
  /** 该按钮发出的意图 action；缺省 `select`。**必须在白名单内**，否则该按钮不渲染。 */
  action?: string;
}

export interface GenUiComponent {
  type: string;
  id: string;
  props?: Record<string, unknown>;
  children?: GenUiComponent[];
}

export interface GenUiSchema {
  v: number;
  id: string;
  complete: boolean;
  meta: { generatedBy: GenUiGeneratedBy; provenance: GenUiProvenance; at?: number };
  root: GenUiComponent;
}

/** 意图（按钮只发这个；主进程一个入口）。 */
export interface GenUiIntent {
  schemaId: string;
  componentId: string;
  action: string;
  payload: Record<string, unknown>;
}

/** 白名单 action（`UI §4.7` 冻结；其余一律拒绝）。 */
export const GENUI_ACTIONS = ['select', 'submit', 'ack', 'open-artifact', 'approve', 'reject'] as const;
export type GenUiAction = (typeof GENUI_ACTIONS)[number];

/** M1 支持的组件类型（其余 → 整卡降级 legacy 文本，不白屏）。 */
export const GENUI_TYPES_M1 = ['stack', 'text', 'button-group', 'disclosure', 'progress'] as const;
/** M4 组件：本轮**不支持**（含 `chart`/`table`/`form`）→ 走降级。 */
export const GENUI_TYPES_M4 = ['form', 'table', 'chart'] as const;

/** 禁止出现在 schema 的语义（渲染器一律拒绝；从根上避免"卡片绕过 permissionGate"）。 */
export const FORBIDDEN_SEMANTICS = ['shell', 'exec', 'openpath', 'merge', 'write-file', 'http', 'eval', 'fetch'] as const;

export function isAllowedAction(action: string): action is GenUiAction {
  return (GENUI_ACTIONS as readonly string[]).includes(action);
}

export function isForbiddenSemantic(value: string): boolean {
  return FORBIDDEN_SEMANTICS.includes(value.trim().toLowerCase() as (typeof FORBIDDEN_SEMANTICS)[number]);
}

export type GenUiValidation =
  | { ok: true; schema: GenUiSchema; rejectedActions: Array<{ componentId: string; action: string }> }
  | { ok: false; reason: string };

const MAX_DEPTH = 8;
const MAX_NODES = 200;

/**
 * 校验并规范化 schema（纯函数）。
 * - 非法（非对象 / `v!==1` / 缺 `id` / 未知或 M4 组件类型 / 超深超量）→ `ok:false`（调用方降级 legacy 文本）；
 * - `button-group` 里 **action 不在白名单**的按钮 → **从结果里剔除**并记入 `rejectedActions`（AC3），其余照常渲染。
 */
export function validateSchema(raw: unknown): GenUiValidation {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'not_an_object' };
  const record = raw as Record<string, unknown>;
  if (record.v !== 1) return { ok: false, reason: 'bad_version' };
  if (typeof record.id !== 'string' || record.id.length === 0) return { ok: false, reason: 'missing_id' };
  const meta = record.meta as Record<string, unknown> | undefined;
  const generatedBy = (meta?.generatedBy ?? {}) as GenUiGeneratedBy;
  const provenance = (meta?.provenance ?? 'employee') as GenUiProvenance;
  if (!['assistant', 'employee', 'external-echo'].includes(provenance)) return { ok: false, reason: 'bad_provenance' };

  const rejectedActions: Array<{ componentId: string; action: string }> = [];
  let nodes = 0;
  // 任一节点非法（未知/M4 类型、缺 type/id、超深超量）→ **整体非法**（调用方降级 legacy 文本，不白屏）。
  let failed = false;

  const visit = (node: unknown, depth: number): GenUiComponent | null => {
    if (depth > MAX_DEPTH) { failed = true; return null; }
    if (!node || typeof node !== 'object') { failed = true; return null; }
    const n = node as Record<string, unknown>;
    const type = typeof n.type === 'string' ? n.type : '';
    const id = typeof n.id === 'string' ? n.id : '';
    if (!type || !id) { failed = true; return null; }
    nodes += 1;
    if (nodes > MAX_NODES) { failed = true; return null; }
    if (!(GENUI_TYPES_M1 as readonly string[]).includes(type)) { failed = true; return null; } // M4/未知类型 → 整体非法

    const props = (n.props && typeof n.props === 'object' ? n.props : {}) as Record<string, unknown>;

    if (type === 'button-group') {
      const actionsRaw = Array.isArray(props.actions) ? props.actions : [];
      const actions: GenUiActionDef[] = [];
      for (const a of actionsRaw) {
        if (!a || typeof a !== 'object') continue;
        const ar = a as Record<string, unknown>;
        const key = typeof ar.key === 'string' ? ar.key : '';
        const label = typeof ar.label === 'string' ? ar.label : '';
        if (!key || !label) continue;
        const action = typeof ar.action === 'string' ? ar.action : 'select';
        if (!isAllowedAction(action) || isForbiddenSemantic(action)) {
          // 非白名单 / 危险 action → **该按钮不渲染**，并记录（AC3）
          rejectedActions.push({ componentId: id, action });
          continue;
        }
        actions.push({
          key,
          label,
          ...(ar.variant === 'primary' || ar.variant === 'ghost' || ar.variant === 'danger'
            ? { variant: ar.variant }
            : {}),
          ...(ar.recommended === true ? { recommended: true } : {}),
          ...(ar.disabled === true ? { disabled: true } : {}),
          ...(action !== 'select' ? { action } : {}),
        });
      }
      return { type, id, props: { ...props, actions } };
    }

    const childrenRaw = Array.isArray(n.children) ? n.children : undefined;
    const children = childrenRaw
      ? (childrenRaw.map((c) => visit(c, depth + 1)).filter((c): c is GenUiComponent => c !== null))
      : undefined;
    return { type, id, props, ...(children ? { children } : {}) };
  };

  const root = visit(record.root, 1);
  if (!root || failed) return { ok: false, reason: 'invalid_component' };

  return {
    ok: true,
    schema: {
      v: 1,
      id: record.id,
      complete: record.complete !== false,
      meta: { generatedBy, provenance, ...(typeof meta?.at === 'number' ? { at: meta.at } : {}) },
      root,
    },
    rejectedActions,
  };
}

/** 一个增量操作（`evt:message{schemaPatch}`）。 */
export interface GenUiPatchOp {
  op: 'add' | 'replace' | 'remove';
  path: string;
  value?: unknown;
}
export interface GenUiSchemaPatch {
  id: string;
  ops: GenUiPatchOp[];
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** 按 JSON Pointer（`/root/children/0/…`）在**深拷贝**上做局部替换；非法路径静默忽略（不抛）。 */
export function applySchemaPatch(schema: GenUiSchema, ops: readonly GenUiPatchOp[]): GenUiSchema {
  const next = clone(schema);
  for (const op of ops) {
    const segs = op.path.split('/').filter((s) => s.length > 0);
    if (segs.length === 0) continue;
    let cursor: unknown = next;
    let ok = true;
    for (let i = 0; i < segs.length - 1; i += 1) {
      const seg = segs[i];
      if (Array.isArray(cursor)) {
        const idx = Number(seg);
        if (!Number.isInteger(idx) || idx < 0 || idx >= cursor.length) { ok = false; break; }
        cursor = cursor[idx];
      } else if (cursor && typeof cursor === 'object') {
        cursor = (cursor as Record<string, unknown>)[seg];
      } else { ok = false; break; }
    }
    if (!ok || !cursor) continue;
    const last = segs[segs.length - 1];
    if (Array.isArray(cursor)) {
      const idx = Number(last);
      if (op.op === 'remove') {
        if (Number.isInteger(idx)) cursor.splice(idx, 1);
      } else if (op.op === 'add') {
        cursor.splice(Number.isInteger(idx) ? idx : cursor.length, 0, op.value);
      } else {
        if (Number.isInteger(idx) && idx >= 0 && idx < cursor.length) cursor[idx] = op.value;
      }
    } else {
      const obj = cursor as Record<string, unknown>;
      if (op.op === 'remove') delete obj[last];
      else obj[last] = op.value;
    }
  }
  return next;
}
