/**
 * GAP9（M3-N-5）· `company:config` IPC：导出 / 预览 diff / 应用 / 回滚。
 *
 * 安全边界：
 *  - 文件固定为 `<项目根>/.aico/company.json`（备份 `.aico/company.backup.json`）；
 *  - renderer 只给 `projectId` 与 token，不给路径；
 *  - apply 必须先 preview 拿 token；文件被改/缺失 → `stale_config`；
 *  - 非法配置/忙碌员工停用 → 整体拒；apply 前备份，rollback 只认备份。
 */
import { rmSync } from 'node:fs';

import type { IpcDeps } from './ipc.js';
import {
  applyCompanyConfig,
  backupCompanyConfig,
  companyApplyJournalPath,
  diffCompanyConfig,
  exportCompanyConfigToProject,
  readApplyJournal,
  readCompanyBackupFromProject,
  readCompanyConfigFromProject,
  undoAppliedAdditions,
  undoAppliedSettings,
  writeApplyJournal,
  writeCompanyConfigFile,
  COMPANY_BACKUP_RELATIVE,
  COMPANY_CONFIG_RELATIVE,
  type CompanyDiff,
} from '../company/config.js';

export type CompanyConfigResult =
  | {
      ok: true;
      action: 'export' | 'preview' | 'apply' | 'rollback';
      path: string;
      token?: string;
      diff?: CompanyDiff;
      employees: number;
      settings: number;
      backupPath?: string;
      applied?: {
        added: string[];
        updated: string[];
        skipped: string[];
        settings: string[];
        removed?: string[];
        deactivated?: string[];
      };
    }
  | { ok: false; code: string; message: string; errors?: string[] };

export function handleCompanyConfig(deps: IpcDeps, raw: unknown, at: number): CompanyConfigResult {
  const input = (raw ?? {}) as { projectId?: unknown; action?: unknown; token?: unknown };
  const projectId = typeof input.projectId === 'number' && Number.isInteger(input.projectId) ? input.projectId : null;
  if (projectId == null) return { ok: false, code: 'bad_request', message: 'projectId 需为整数' };
  const project = deps.repo.getProject(projectId);
  if (!project) return { ok: false, code: 'not_found', message: `项目不存在：${projectId}` };
  const db = deps.db;
  if (!db) return { ok: false, code: 'db_unavailable', message: '主进程数据库未接线' };
  const root = project.rootDir;
  const action = input.action;

  if (action === 'export') {
    try {
      const res = exportCompanyConfigToProject(db, root, at);
      return {
        ok: true,
        action: 'export',
        path: COMPANY_CONFIG_RELATIVE,
        employees: res.config.employees.length,
        settings: Object.keys(res.config.settings).length,
      };
    } catch (error) {
      return { ok: false, code: 'write_failed', message: error instanceof Error ? error.message : String(error) };
    }
  }

  if (action === 'preview') {
    const read = readCompanyConfigFromProject(root);
    if (!read.ok) return read;
    const diff = diffCompanyConfig(db, read.config);
    return {
      ok: true,
      action: 'preview',
      path: COMPANY_CONFIG_RELATIVE,
      token: read.token,
      diff,
      employees: read.config.employees.length,
      settings: Object.keys(read.config.settings).length,
    };
  }

  if (action === 'apply') {
    const read = readCompanyConfigFromProject(root);
    if (!read.ok) return read;
    if (typeof input.token !== 'string' || input.token.length === 0) {
      return { ok: false, code: 'bad_request', message: 'apply 需要 preview 返回的 token' };
    }
    if (input.token !== read.token) {
      return { ok: false, code: 'stale_config', message: '配置文件在预览后被改动，请重新预览' };
    }
    const preDiff = diffCompanyConfig(db, read.config);
    try {
      backupCompanyConfig(root, db, at);
      writeApplyJournal(root, preDiff.added, preDiff.settings.added, at);
    } catch (error) {
      return { ok: false, code: 'backup_failed', message: `备份失败，未应用：${error instanceof Error ? error.message : String(error)}` };
    }
    const res = applyCompanyConfig(db, read.config, at);
    if (!res.ok) return res;
    return {
      ok: true,
      action: 'apply',
      path: COMPANY_CONFIG_RELATIVE,
      backupPath: COMPANY_BACKUP_RELATIVE,
      applied: {
        added: res.added,
        updated: preDiff.updated.map((u) => u.name),
        skipped: res.skipped,
        settings: res.settings,
      },
      employees: read.config.employees.length,
      settings: Object.keys(read.config.settings).length,
    };
  }

  if (action === 'rollback') {
    const read = readCompanyBackupFromProject(root);
    if (!read.ok) return read;
    const journal = readApplyJournal(root);
    const res = applyCompanyConfig(db, read.config, at);
    if (!res.ok) return res;
    const undone = undoAppliedAdditions(db, journal.added);
    undoAppliedSettings(db, journal.settingsAdded);
    try {
      writeCompanyConfigFile(root, read.config);
      rmSync(companyApplyJournalPath(root), { force: true });
    } catch (error) {
      return {
        ok: false,
        code: 'rollback_file_failed',
        message: `数据库已回滚，但 company.json 回写失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return {
      ok: true,
      action: 'rollback',
      path: COMPANY_CONFIG_RELATIVE,
      backupPath: COMPANY_BACKUP_RELATIVE,
      applied: {
        added: res.added,
        updated: res.updated,
        skipped: res.skipped,
        settings: res.settings,
        removed: undone.removed,
        deactivated: undone.deactivated,
      },
      employees: read.config.employees.length,
      settings: Object.keys(read.config.settings).length,
    };
  }

  return { ok: false, code: 'bad_request', message: `未知 action：${String(action)}（export/preview/apply/rollback）` };
}
