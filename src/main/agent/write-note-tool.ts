/**
 * K1 员工 `write_note` 工具（与 submit_work_item 同级）。
 *
 * 员工干完活觉得经验值得记 → 直接写入当前项目的 `.aico/notes/`。
 * 只能写自己项目的笔记（安全边界）；走 tool_call 审计。
 */
import type { SqliteDb } from '../db/open.js';
import { writeNote, safeNoteName } from './notes.js';
import { sessionCwd } from './tools/session-cwd.js';

export async function createWriteNoteTool(db: SqliteDb) {
  const [{ defineTool }, { Type }] = await Promise.all([
    import('@earendil-works/pi-coding-agent'),
    import('@earendil-works/pi-ai'),
  ]);
  return defineTool({
    name: 'write_note',
    label: 'Write Note',
    description:
      '把经验/决定/操作步骤写入当前项目的笔记（.aico/notes/），供后续任务检索。' +
      '只在有值得沉淀的知识时调用（部署步骤、踩坑经验、设计决定等），不要把任务报告存为笔记。',
    parameters: Type.Object({
      name: Type.String({ description: '笔记文件名（不含 .md，如 deploy-runbook）' }),
      content: Type.String({ description: '笔记内容（Markdown）' }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const safe = safeNoteName(params.name);
      if (safe == null) {
        return {
          content: [{ type: 'text', text: `文件名不安全：${params.name}（只允许中英文/数字/横线/下划线）` }],
          details: { ok: false, path: '', error: '' },
        };
      }
      // B4b 接线审查 F1（2026-11-09）：项目根优先取**本会话 cwd**（与门禁/其它工具同源）——
      // 旧逻辑取「全局最近一次 task_started 的任务」，多项目并发时会把笔记写进**别人的项目**。
      // ctx 缺失（旧调用方/单测）回落旧查询，行为不变。
      let rootDir: string | undefined = sessionCwd(ctx, '') || undefined;
      if (rootDir == null) {
        const task = db
          .prepare(
            'SELECT p.root_dir FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = (SELECT MAX(task_id) FROM task_events WHERE kind = ? ORDER BY id DESC LIMIT 1)',
          )
          .get('task_started') as { root_dir: string } | undefined;
        rootDir = task?.root_dir;
      }
      const task = { root_dir: rootDir };
      if (task?.root_dir == null) {
        return {
          content: [{ type: 'text', text: '无法确定当前项目（没有活跃任务）——笔记需要项目上下文。' }],
          details: { ok: false, path: '', error: '' },
        };
      }
      const result = writeNote({ projectDir: task.root_dir, globalDir: '', name: safe, content: params.content });
      if (result.ok) {
        return {
          content: [{ type: 'text', text: `已存为项目笔记「${safe}」（${result.path}）` }],
          details: { ok: true, path: result.path, error: '' },
        };
      }
      return {
        content: [{ type: 'text', text: `写入失败：${result.error}` }],
        details: { ok: false, path: '', error: result.error },
      };
    },
  });
}
