/**
 * 迁移集（DEV §4）—— **打包安全**：迁移 SQL 以 TS 常量**内联**，运行时**不读文件系统**。
 *
 * 为什么内联：打包后 main 产物在 `out/`（并进 asar），按“源码树 / cwd”探测会**找不到** `migrations/*.sql`；
 * 而本项目的测试构建用 `tsc`（不吃 `?raw`），故采用「TS 常量 = 权威 `schema.sql` 的逐字内容」方案，
 * dev 与打包**同一份代码路径**。源文件 `migrations/NNN_*.sql` 仍保留供人审计；
 * `test/migrations-packaging.test.ts` 在源码树存在时校验「内联常量 == .sql 文件」防漂移。
 */
import { createHash } from 'node:crypto';

import { SQL_001_INIT } from './migrations/001_init.js';
import { SQL_002_VERIFICATION_SEAMS } from './migrations/002_verification_seams.js';
import { SQL_003_ARTIFACT_CHANGESET } from './migrations/003_artifact_changeset.js';
import { SQL_004_COST_CLOSURE } from './migrations/004_cost_closure.js';
import { SQL_005_CONCURRENCY_COMPANY_COST } from './migrations/005_concurrency_company_cost.js';
import { SQL_006_MAILBOX_READ } from './migrations/006_mailbox_read.js';
import { SQL_007_ARTIFACT_REFS } from './migrations/007_artifact_refs.js';
import { SQL_008_REPORTS_NULLABLE_TASK } from './migrations/008_reports_nullable_task.js';
import { SQL_009_TASK_MODEL } from './migrations/009_task_model.js';
import { SQL_010_PROJECT_STAFFING } from './migrations/010_project_staffing.js';
import { SQL_011_PROJECT_DOCS_CHECK } from './migrations/011_project_docs_check.js';
import { SQL_012_TASK_CHECKPOINTS } from './migrations/012_task_checkpoints.js';
import { SQL_013_IM_OUTBOX } from './migrations/013_im_outbox.js';
import { SQL_014_REMOTE_FOUNDATION } from './migrations/014_remote_foundation.js';
import { SQL_015_TASK_PAUSE_REASON } from './migrations/015_task_pause_reason.js';
import { SQL_016_MEMORY_ITEMS } from './migrations/016_memory_items.js';
import { SQL_017_MEMORY_FTS } from './migrations/017_memory_fts.js';
import { SQL_018_PROJECT_MODEL_POLICY } from './migrations/018_project_model_policy.js';
import { SQL_019_PROJECT_DEFAULT_BUDGET } from './migrations/019_project_default_budget.js';
import { SQL_020_CONTEXT_METRICS } from './migrations/020_context_metrics.js';
import { SQL_021_CONTEXT_METRICS_MODEL_HASH } from './migrations/021_context_metrics_model_hash.js';
import { SQL_022_PROJECT_TARGET_BRANCH } from './migrations/022_project_target_branch.js';
import { SQL_023_WORK_ITEM_DEPS } from './migrations/023_work_item_deps.js';
import { SQL_024_PROJECT_DOCUMENTS } from './migrations/024_project_documents.js';

export interface Migration {
  /** 版本号（基线 = 1；严格递增、不复用）。 */
  version: number;
  /** 迁移名（文件名去掉 `NNN_` 前缀与 `.sql` 后缀），如 `init`。 */
  name: string;
  /** 迁移文件名，如 `001_init.sql`。 */
  file: string;
  /** 迁移全文（内联常量）。 */
  sql: string;
  /** 迁移内容 sha256（防「改写历史迁移」）。 */
  checksum: string;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 基线迁移集（按版本升序）。新增迁移：加 `migrations/NNN_*.sql` + 对应 TS 常量 + 在此登记。 */
const BASELINE: ReadonlyArray<Omit<Migration, 'checksum'>> = [
  { version: 1, name: 'init', file: '001_init.sql', sql: SQL_001_INIT },
  { version: 2, name: 'verification_seams', file: '002_verification_seams.sql', sql: SQL_002_VERIFICATION_SEAMS },
  {
    version: 3,
    name: 'artifact_changeset',
    file: '003_artifact_changeset.sql',
    sql: SQL_003_ARTIFACT_CHANGESET,
  },
  { version: 4, name: 'cost_closure', file: '004_cost_closure.sql', sql: SQL_004_COST_CLOSURE },
  {
    version: 5,
    name: 'concurrency_company_cost',
    file: '005_concurrency_company_cost.sql',
    sql: SQL_005_CONCURRENCY_COMPANY_COST,
  },
  { version: 6, name: 'mailbox_read', file: '006_mailbox_read.sql', sql: SQL_006_MAILBOX_READ },
  { version: 7, name: 'artifact_refs', file: '007_artifact_refs.sql', sql: SQL_007_ARTIFACT_REFS },
  {
    version: 8,
    name: 'reports_nullable_task',
    file: '008_reports_nullable_task.sql',
    sql: SQL_008_REPORTS_NULLABLE_TASK,
  },
  { version: 9, name: 'task_model', file: '009_task_model.sql', sql: SQL_009_TASK_MODEL },
  { version: 10, name: 'project_staffing', file: '010_project_staffing.sql', sql: SQL_010_PROJECT_STAFFING },
  { version: 11, name: 'project_docs_check', file: '011_project_docs_check.sql', sql: SQL_011_PROJECT_DOCS_CHECK },
  { version: 12, name: 'task_checkpoints', file: '012_task_checkpoints.sql', sql: SQL_012_TASK_CHECKPOINTS },
  { version: 13, name: 'im_outbox', file: '013_im_outbox.sql', sql: SQL_013_IM_OUTBOX },
  { version: 14, name: 'remote_foundation', file: '014_remote_foundation.sql', sql: SQL_014_REMOTE_FOUNDATION },
  { version: 15, name: 'task_pause_reason', file: '015_task_pause_reason.sql', sql: SQL_015_TASK_PAUSE_REASON },
  { version: 16, name: 'memory_items', file: '016_memory_items.sql', sql: SQL_016_MEMORY_ITEMS },
  { version: 17, name: 'memory_fts', file: '017_memory_fts.sql', sql: SQL_017_MEMORY_FTS },
  {
    version: 18,
    name: 'project_model_policy',
    file: '018_project_model_policy.sql',
    sql: SQL_018_PROJECT_MODEL_POLICY,
  },
  {
    version: 19,
    name: 'project_default_budget',
    file: '019_project_default_budget.sql',
    sql: SQL_019_PROJECT_DEFAULT_BUDGET,
  },
  {
    version: 20,
    name: 'context_metrics',
    file: '020_context_metrics.sql',
    sql: SQL_020_CONTEXT_METRICS,
  },
  {
    version: 21,
    name: 'context_metrics_model_hash',
    file: '021_context_metrics_model_hash.sql',
    sql: SQL_021_CONTEXT_METRICS_MODEL_HASH,
  },
  {
    version: 22,
    name: 'project_target_branch',
    file: '022_project_target_branch.sql',
    sql: SQL_022_PROJECT_TARGET_BRANCH,
  },
  {
    version: 23,
    name: 'work_item_deps',
    file: '023_work_item_deps.sql',
    sql: SQL_023_WORK_ITEM_DEPS,
  },
  {
    version: 24,
    name: 'project_documents',
    file: '024_project_documents.sql',
    sql: SQL_024_PROJECT_DOCUMENTS,
  },
];

/** 加载迁移集（纯内存，无文件系统访问）：附加 checksum 并校验版本唯一/严格递增。 */
export function loadMigrations(): Migration[] {
  const migrations: Migration[] = BASELINE.map((m) => ({ ...m, checksum: sha256(m.sql) }));

  const seen = new Map<number, string>();
  let previous = 0;
  for (const m of migrations) {
    const dup = seen.get(m.version);
    if (dup) throw new Error(`[db] 迁移版本号重复: ${m.version}（${dup} / ${m.file}）`);
    if (m.version <= previous) {
      throw new Error(`[db] 迁移版本号必须严格递增: ${m.file} 出现在 ${previous} 之后`);
    }
    seen.set(m.version, m.file);
    previous = m.version;
  }
  return migrations;
}
