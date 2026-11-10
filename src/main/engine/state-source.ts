/**
 * OPT- · 「状态位同源」结构守卫。
 *
 * 硬口径：**同一状态只有一个写入源**（单一真源），冲突即红。
 *  - `tasks.state` —— 真源 = 状态机投影（`engine/loop.ts`）经 DAO（`db/tasks.ts`）写入；**其它文件不得直接写 `state` 列**。
 *  - `work_items.state` —— 真源 = `engine/loop.ts` 经 `db/work_items.ts` 写入。
 *
 * `findStateWriterViolations` 是纯函数（吃源码文本），供 `test/doc-consistency.test.ts`
 * 既扫**真实 src**（应零违规），也吃**合成违规**（证明守卫有牙）。
 */

export interface SourceFile {
  /** 统一用 `/` 分隔的相对路径（相对仓库根）。 */
  file: string;
  text: string;
}

export interface StateWriteRule {
  table: 'tasks' | 'work_items';
  key: string;
  /** 拥有 `UPDATE <table> SET` 原始 SQL 的 DAO 文件（唯一合法位置）。 */
  dao: string;
  /** 计算并提交该状态的**唯一写入者**（状态机投影）。 */
  writer: string;
  /** 合法调用 DAO 的入口函数名。 */
  caller: 'updateTask' | 'updateWorkItem';
}

export const STATE_WRITE_RULES: readonly StateWriteRule[] = [
  {
    table: 'tasks',
    key: 'tasks.state',
    dao: 'src/main/db/tasks.ts',
    writer: 'src/main/engine/loop.ts',
    caller: 'updateTask',
  },
  {
    table: 'work_items',
    key: 'work_items.state',
    dao: 'src/main/db/work_items.ts',
    writer: 'src/main/engine/loop.ts',
    caller: 'updateWorkItem',
  },
];

export interface StateWriterViolation {
  file: string;
  line: number;
  key: string;
  reason: string;
  snippet: string;
}

const norm = (p: string): string => p.replace(/\\/g, '/');

/** 该 SET 子句是否**直接**写 `state` 列（`resume_state`/`state_before_close` 不算）。 */
function writesStateColumn(setClause: string): boolean {
  return /(^|[\s,])state\s*=/i.test(setClause);
}

export function findStateWriterViolations(sources: SourceFile[]): StateWriterViolation[] {
  const violations: StateWriterViolation[] = [];
  const byFile = new Map(sources.map((s) => [norm(s.file), s]));

  for (const rule of STATE_WRITE_RULES) {
    const allowedSqlFiles = new Set([norm(rule.dao)]);
    const allowedCallFiles = new Set([norm(rule.dao), norm(rule.writer)]);

    for (const src of sources) {
      const file = norm(src.file);
      const lines = src.text.split('\n');
      // ① 原始 SQL：只有 DAO 可以出现 `UPDATE <table> SET … state =`。
      if (!allowedSqlFiles.has(file)) {
        const re = new RegExp(`UPDATE\\s+${rule.table}\\s+SET`, 'i');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] as string;
          if (!re.test(line)) continue;
          // 收集本语句 SET 子句（粗略：从该行到出现 WHERE 或语句结尾）。
          let setClause = line.slice(line.search(re) + String(line.match(re)?.[0] ?? '').length);
          let j = i;
          while (!/\bWHERE\b/i.test(setClause) && j + 1 < lines.length && !/;\s*$/.test(setClause)) {
            j += 1;
            setClause += '\n' + (lines[j] as string);
          }
          if (writesStateColumn(setClause)) {
            violations.push({
              file,
              line: i + 1,
              key: rule.key,
              reason: `直接写 ${rule.table}.state，唯一真源应为 ${rule.writer}（经 ${rule.dao}）`,
              snippet: line.trim(),
            });
          }
        }
      }
      // ② 调用入口：只有 DAO 与唯一写入者可以调用 `updateTask/updateWorkItem`。
      if (!allowedCallFiles.has(file)) {
        const callRe = new RegExp(`\\b${rule.caller}\\s*\\(`);
        for (let i = 0; i < lines.length; i++) {
          if (callRe.test(lines[i] as string)) {
            violations.push({
              file,
              line: i + 1,
              key: rule.key,
              reason: `非唯一写入者调用 ${rule.caller}（真源 = ${rule.writer}）`,
              snippet: (lines[i] as string).trim(),
            });
          }
        }
      }
    }
  }
  return violations;
}

/** 便捷：从「文件→文本」映射构造并检查（测试用）。 */
export function findStateWriterViolationsIn(sources: Iterable<[string, string]>): StateWriterViolation[] {
  return findStateWriterViolations([...sources].map(([file, text]) => ({ file, text })));
}
