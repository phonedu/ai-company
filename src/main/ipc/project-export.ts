/**
 * B-3· `project:export` —— 项目删除前的数据导出/备份。
 *
 * 口径（`` ②）：归档优先＋软删除＋导出；**硬删仅“已归档且无任务”**，且 UI 删除前会先调用本导出。
 * 产物：单文件 JSON（项目 + 全部任务详情 + 项目记忆），落 main 注入的 `exportDir`
 * （默认 `userData/exports`）；同名覆盖＝同一项目始终一个档案文件。
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SqliteDb } from '../db/open.js';
import { SqliteMemoryStore, type MemoryItem } from '../memory/index.js';
import type { ChatRepo } from './ports.js';

export const PROJECT_EXPORT_SCHEMA = 'aico.project-export/v1';

export interface ProjectExportDeps {
  repo: ChatRepo;
  db?: SqliteDb;
  exportDir?: () => string;
}

export type ProjectExportResult =
  | { ok: true; path: string; bytes: number; schema: string }
  | { ok: false; code: string; message: string };

function safeFilePart(value: string): string {
  return value.replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_').slice(0, 60) || 'project';
}

export function handleExportProject(deps: ProjectExportDeps, raw: unknown, at: number): ProjectExportResult {
  const input = (raw ?? {}) as { projectId?: unknown };
  if (typeof input.projectId !== 'number' || !Number.isInteger(input.projectId) || input.projectId <= 0) {
    return { ok: false, code: 'bad_request', message: 'projectId 需为正整数' };
  }
  const project = deps.repo.getProject(input.projectId);
  if (!project) return { ok: false, code: 'not_found', message: `项目不存在：#${input.projectId}` };
  if (!deps.exportDir) return { ok: false, code: 'export_unavailable', message: '导出目录不可用（非桌面环境）' };

  let memory: MemoryItem[] = [];
  if (deps.db) {
    try {
      memory = new SqliteMemoryStore(deps.db).list({
        scope: { type: 'project', projectId: project.id },
        includeArchived: true,
        includeHistorical: true,
        limit: 500,
      });
    } catch {
      // 记忆导出失败不阻断项目档案；明确写空数组（不伪造条目）。
      memory = [];
    }
  }
  const tasks = deps.repo.listTasks({ projectId: project.id, includeArchived: true });
  const taskDetails = tasks.map((task) => deps.repo.getTaskDetail(task.id)).filter((detail) => detail != null);

  let dir: string;
  try {
    dir = deps.exportDir();
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    return { ok: false, code: 'export_failed', message: `创建导出目录失败：${error instanceof Error ? error.message : String(error)}` };
  }
  const file = join(dir, `project-${project.id}-${safeFilePart(project.name)}.json`);
  const bundle = {
    schema: PROJECT_EXPORT_SCHEMA,
    exportedAt: at,
    project,
    tasks: taskDetails,
    memory,
  };
  try {
    writeFileSync(file, JSON.stringify(bundle, null, 2), 'utf8');
    return { ok: true, path: file, bytes: statSync(file).size, schema: PROJECT_EXPORT_SCHEMA };
  } catch (error) {
    return { ok: false, code: 'export_failed', message: `写导出文件失败：${error instanceof Error ? error.message : String(error)}` };
  }
}
