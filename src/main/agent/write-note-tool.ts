/**
 * K1 员工 `write_note` 工具（与 submit_work_item 同级）。
 *
 * 员工干完活觉得经验值得记 → 直接写入当前项目的 `.aico/notes/`。
 * 只能写自己项目的笔记（安全边界）；走 tool_call 审计。
 */
import type { SqliteDb } from '../db/open.js';
import { writeNote, safeNoteName } from './notes.js';

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
    async execute(_toolCallId, params) {
      const safe = safeNoteName(params.name);
      if (safe == null) {
        return {
          content: [{ type: 'text', text: `文件名不安全：${params.name}（只允许中英文/数字/横线/下划线）` }],
          details: { ok: false, path: '', error: '' },
        };
      }
      // 从 db 取当前任务的项目根目录
      const task = db
        .prepare(
          'SELECT p.root_dir FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = (SELECT MAX(task_id) FROM task_events WHERE kind = ? ORDER BY id DESC LIMIT 1)',
        )
        .get('task_started') as { root_dir: string } | undefined;
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
