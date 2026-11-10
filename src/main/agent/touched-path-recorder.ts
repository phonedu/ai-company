/**
 * · 路径所有权**执行期实测**采集器。
 *
 * 背景：并行正确性此前建立在「路径预言」上（touched_paths 塞 brief）； 因无测量用
 * `'.'` 整树认领兜底 ⇒ inplace 恒串行。本采集器在**工具调用执行前**（与权限闸门同点位
 * `pi.on('tool_call')`）登记员工实际触碰的路径：
 *  - `read`/`write`/`edit`/`grep`/`find` → 提取路径参数（真实触碰）；
 *  - bash → 只读白名单内不认领；**非只读保守认领整树 `'.'`**（宁可串行、不可互踩）；
 *  - mcp_call → 不可测，保守整树；
 *  - 流程工具（submit_work_item/ask_colleague/…）不认领。
 * 登记走引擎 `recordWorkItemTouchedPaths`（内存 ws.touched ∪ DB brief，崩溃恢复不丢已测事实）。
 */
import { isReadOnlyBashCommand } from '../permission/readonly-bash.js';
import { extractSessionId } from './session-tool-gate.js';
import { exportPathFor, type ExportFormat } from './tools/export-format-tool.js';

/** 从一次工具调用提取「本件实际触碰的路径」（`'.'`=整树）。纯函数，可测。 */
export function extractTouchedPathsFromTool(
  event: { toolName: string; input?: Record<string, unknown> },
  roots: { projectRoot?: string | null; cwd?: string | null } = {},
): string[] {
  const name = event.toolName.toLowerCase();
  if (name === 'bash' || name === 'powershell' || name === 'shell' || name === 'exec' || name === 'cmd') {
    const command = String(
      (event.input as { command?: unknown; cmd?: unknown } | undefined)?.command ??
        (event.input as { cmd?: unknown } | undefined)?.cmd ??
        '',
    );
    if (command.trim().length === 0) return [];
    // 只读 bash 不认领（白名单＋圈根三关；三关任一不过 → 保守整树）。
    if (isReadOnlyBashCommand(command, roots)) return [];
    return ['.'];
  }
  if (name === 'mcp_call' || name === 'mcp') return ['.'];
  //  接线审查 （2026-11-09）：内容工具固定产出目录/派生文件认领（并行隔离不再对这些盲区）。
  if (name === 'image_generate') return ['assets/images'];
  if (name === 'screenshot') return ['.aico/screenshots'];
  if (name === 'write_note') return ['.aico/notes'];
  if (name === 'export_format') {
    const path = (event.input as { path?: unknown } | undefined)?.path;
    const format = (event.input as { format?: unknown } | undefined)?.format;
    if (typeof path === 'string' && path.trim().length > 0) {
      const out = typeof format === 'string' ? exportPathFor(path, format as ExportFormat) : null;
      return out != null ? [path, out] : [path];
    }
    return [];
  }
  if (name === 'read' || name === 'write' || name === 'edit' || name === 'ls' || name === 'grep' || name === 'find') {
    const args = event.input ?? {};
    for (const key of ['path', 'file', 'filePath', 'file_path', 'dir']) {
      const v = args[key];
      if (typeof v === 'string' && v.trim().length > 0) return [v.trim()];
    }
    return [];
  }
  return [];
}

/** 会话归属（复用 SessionToolGate 的登记；record 采集与闸门同一 sessionId 事实源）。 */
export interface TouchedPathSessionRef {
  workItemId: number | null;
  cwd?: string;
  projectRoot?: string | null;
}

export interface TouchedPathRecorderDeps {
  /** sessionId → 会话归属（缺方法/查无 → 不采集，如实降级不假装实测）。 */
  sessionFor?: (sessionId: string) => TouchedPathSessionRef | null;
  /** 登记回调（引擎 `recordWorkItemTouchedPaths`；由装配层注入）。 */
  report: (workItemId: number, paths: string[]) => void;
}

export class TouchedPathRecorder {
  constructor(private readonly deps: TouchedPathRecorderDeps) {}

  /** 注册到 Pi 扩展 API（与权限闸门同点位：工具执行前）。 */
  register(
    pi: {
      on(event: 'tool_call', handler: (event: { toolName: string; input?: Record<string, unknown> }, ctx: unknown) => void): unknown;
    },
  ): void {
    if (this.deps.sessionFor == null) return;
    pi.on('tool_call', (event, ctx) => {
      try {
        const sessionId = extractSessionId(ctx);
        const session = sessionId != null ? (this.deps.sessionFor!(sessionId) ?? null) : null;
        if (session == null || session.workItemId == null) return;
        const paths = extractTouchedPathsFromTool(event, { cwd: session.cwd ?? null, projectRoot: session.projectRoot ?? null });
        if (paths.length === 0) return;
        this.deps.report(session.workItemId, paths);
      } catch (error) {
        // 采集失败不能反噬会话（工具照常执行），但必须响（不静默）。
        console.error('[touched-path] 采集登记失败（会话继续）', error);
      }
    });
  }
}
