/**
 * 短号：人类与 IM 可寻址的 ID。任务 `T-1042`，项目别名「记账」。
 *
 * 三条硬规则：
 *  1. 单调递增、永不复用 —— 旧卡片上的 `T-1042` 回复必须永远指向同一个任务，
 *     否则"回复一条旧推送"会静默作用到另一个任务上（比爆炸更可怕的静默错误）。
 *     允许出现空洞（跳号无害），绝不允许回收。
 *  2. 短号计数器自增**独立提交**（允许空洞、永不复用）；任务 INSERT 必须携带已分配的 `short_id`，并与其余写入同事务。
 *     理由：第一不变式是「永不复用」，而同一事务下 ROLLBACK 必然回收序号，二者不可兼得 -> 取更强的「永不复用」，代价是允许空洞。
 *  3. 解析宽松（`#t1042`、`#T-1042` 都接受），规范化输出严格（`T-1042`）。
 */

export interface CounterStore {
  /** 原子自增并返回新值。实现层以单条原子语句自增并**独立提交**（允许空洞、永不复用），保证并发安全。 */
  nextCounter(name: string, start: number): number;
}

export const TASK_ID_PREFIX = 'T-';
export const TASK_ID_START = 1001;

/** 分配一个新的任务短号。调用方：先独立提交计数器自增；再把该 `short_id` 随任务 INSERT 与其余写入同事务。 */
export function allocateTaskShortId(store: CounterStore): string {
  return `${TASK_ID_PREFIX}${store.nextCounter('task_short_id', TASK_ID_START)}`;
}

const TASK_REF_RE = /#\s*T-?(\d{3,})/i;

/** 从消息文本中提取任务短号（`#T1042` / `#T-1042` / `# t1042` 均可），返回规范形式。 */
export function extractTaskRef(text: string): string | null {
  const m = TASK_REF_RE.exec(text);
  if (!m) return null;
  return `${TASK_ID_PREFIX}${Number(m[1])}`;
}

/** 解析"整条文本就是一个任务短号"的场景（命令参数等），不做全文扫描。 */
export function parseTaskRef(text: string): string | null {
  const m = /^\s*#?\s*T-?(\d{3,})\s*$/i.exec(text);
  return m ? `${TASK_ID_PREFIX}${Number(m[1])}` : null;
}

export const ALIAS_MAX_LEN = 8;

export type AliasValidation =
  | { ok: true; alias: string }
  | { ok: false; reason: string };

/** 项目别名校验：1–8 字符、无空白、不以 # 开头、不能长得像任务短号。允许 CJK。 */
export function validateAlias(raw: string): AliasValidation {
  const alias = raw.trim().replace(/^#/, '');
  if (!alias) return { ok: false, reason: '别名不能为空' };
  if ([...alias].length > ALIAS_MAX_LEN) {
    return { ok: false, reason: `别名最长 ${ALIAS_MAX_LEN} 个字符` };
  }
  if (/\s/.test(alias)) return { ok: false, reason: '别名不能包含空白' };
  if (/[#@/\\]/.test(alias)) return { ok: false, reason: '别名不能包含 # @ / \\ 字符' };
  if (/^T-?\d{3,}$/i.test(alias)) return { ok: false, reason: '别名不能与任务短号格式相同' };
  return { ok: true, alias };
}

const PROJECT_REF_RE = /#\s*([^\s#]{1,16})/g;

/** 从消息中提取项目别名（`#记账 …`），自动跳过任务短号。 */
export function extractProjectAlias(text: string): string | null {
  for (const m of text.matchAll(PROJECT_REF_RE)) {
    const raw = m[1] ?? '';
    if (/^T-?\d{3,}$/i.test(raw)) continue; // 那是任务号
    const v = validateAlias(raw);
    if (v.ok) return v.alias;
  }
  return null;
}
