/**
 * `task_status` customTool 定义（MP1-F18：幕僚长只读任务状态查询）。
 *
 * 背景：老板问「T-xxxx 什么状态」是高频路径；幕僚长上下文里没有任务状态、又无查询工具
 * ⇒ 只能答「查不到」。本工具直读真库给紧凑快照（数据面在 `task-status.ts`，纯查询零写入）。
 *
 * ESM/CJS 约束同 `report-progress-tool.ts`：Pi SDK 只能异步动态 import。
 */
import type { SqliteDb } from '../db/open.js';
import { taskStatusSnapshot } from './task-status.js';

export async function createTaskStatusTool(db: SqliteDb) {
  const [{ defineTool }, { Type }] = await Promise.all([
    import('@earendil-works/pi-coding-agent'),
    import('@earendil-works/pi-ai'),
  ]);
  return defineTool({
    name: 'task_status',
    label: 'Task Status',
    description:
      '只读查询任一任务的当前状态快照：状态/计划进度/最近汇报/等待原因/成本/产物。' +
      '输入任务短号（如 T-1002；纯数字按任务 id）。查不到会明说；本工具不改变任何数据。',
    parameters: Type.Object({
      task: Type.String({ description: '任务短号（如 T-1002）或任务 id' }),
    }),
    async execute(_toolCallId, params) {
      const snap = taskStatusSnapshot(db, params.task);
      return {
        content: [
          {
            type: 'text',
            text: snap ? snap.text : `没找到任务 ${params.task}（短号形如 T-1002）。请核对短号后重试；不要凭记忆猜状态。`,
          },
        ],
        details: snap ? { taskId: snap.taskId, shortId: snap.shortId } : { found: false },
      };
    },
  });
}
