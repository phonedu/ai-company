/**
 * OPT-M2-3 · 「删除面 / 语义不变量」结构门（"恰 N 处，缺即红"）。
 *
 * 对照 D-069（误删原生钩子）：对**原生/契约语句在场**加显式不变量断言，每处**点名缺席会导致什么**：
 *  - `preload` 暴露 channel **恰好 78 个**（冻结集合；UG-06 新增 task:diff）；
 *  - 主进程 IPC 注册 channel **恰好 78 个**（冻结集合）；
 *  - 关键契约**常量在场且恰定义 1 处**（防"第三套"）。
 * 与 `guard-matrix` 联动（已登记 `struct-*`），每条断言可被弄红。
 *
 * 注：`test/ipc-contract.test.ts`已验 **集合包含/前缀/字段**；本件**只读**它，不重复其断言，
 * 扩的是**"恰 N 处"计数不变量 + 关键常量在场**（清单里是它的"扩面"）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadMigrations } from '../src/main/db/migrations.js';

const ROOT = process.cwd();

// ── 冻结面（改动即失败，触发复核）─────────────────────────────
export const PRELOAD_CHANNELS = [
  'chat:card-action', 'chat:list', 'chat:resolve-attachment', 'chat:send',
  'cost:summary',
  'docs:check', 'docs:organize-apply', 'docs:organize-preview',
  'employee:get', 'employee:list', 'employee:recruit', 'employee:update', 'file:import', 'file:import-bytes', 'hall:state', 'hall:subscribe',
  'evt:snapshot',
  'im:bind', 'im:unbind', 'inbox:answer', 'inbox:list', 'inbox:read-mark', 'inbox:read-state', 'ipc:bench:ping', 'mailbox:answer', 'mailbox:list', 'mcp:list', 'mcp:set', 'artifact:export', 'git:push', 'git:remotes', 'memory:confirm', 'memory:manage', 'model:catalog', 'notes:delete', 'notes:list', 'notes:preview', 'notes:promote', 'notes:read', 'notes:search', 'notes:write', 'notify:test', 'provider:clear-key', 'provider:custom', 'provider:list', 'provider:set-key',
  'project:alias-set', 'project:archive', 'project:assistant-write-mode-set', 'project:trigger-manage', 'project:attach', 'project:open-dir', 'project:company-config', 'project:create', 'project:delete', 'project:export', 'project:docs-check-set', 'project:get', 'project:list', 'project:model-policy-set', 'project:default-budget-set', 'project:target-branch-set', 'project:skills-set', 'project:staffing-set', 'app:info', 'app:open-data-dir', 'update:get', 'update:check', 'update:download', 'update:install', 'scheduler:slots', 'seams:list', 'search:global', 'settings:get', 'settings:set', 'settings:maintenance', 'settings:permission-list', 'settings:permission-revoke',
  'skills:list', 'skills:set',
  'task:approve', 'task:create', 'task:discard', 'task:edit-plan', 'task:export', 'task:get', 'task:list',
  'task:diff', 'task:merge', 'task:rework-merge-conflict', 'task:read-artifact', 'task:read-tool-output', 'task:reference-artifact', 'task:rollback', 'task:transition', 'ui:mounted',
  // 2026-10-16 替换批·壳层重排：自绘三键（`frame:false`）——有意新增（冻结数随批 +3）。
  'ui:win-close', 'ui:win-is-maximized', 'ui:win-minimize', 'ui:win-toggle-maximize',
].sort();

export const IPC_CHANNELS = [
  'chat:card-action', 'chat:list', 'chat:resolve-attachment', 'chat:send',
  'cost:summary',
  'docs:check', 'docs:organize-apply', 'docs:organize-preview',
  'employee:get', 'employee:list', 'employee:recruit', 'employee:update', 'file:import', 'file:import-bytes',
  'evt:snapshot',
  'hall:state', 'hall:subscribe', 'im:bind', 'im:unbind', 'inbox:answer', 'inbox:list', 'inbox:read-mark', 'inbox:read-state',
  'ipc:bench:ping', 'mailbox:answer', 'mailbox:list', 'mcp:list', 'mcp:set', 'artifact:export', 'git:push', 'git:remotes', 'memory:confirm', 'memory:manage', 'model:catalog', 'notes:delete', 'notes:list', 'notes:preview', 'notes:promote', 'notes:read', 'notes:search', 'notes:write', 'notify:test', 'provider:clear-key', 'provider:custom', 'provider:list', 'provider:set-key', 'project:alias-set', 'project:archive', 'project:assistant-write-mode-set', 'project:trigger-manage', 'project:attach', 'project:open-dir', 'project:company-config', 'project:create', 'project:delete', 'project:export', 'project:docs-check-set', 'project:get', 'project:list', 'project:model-policy-set', 'project:default-budget-set', 'project:target-branch-set', 'project:skills-set', 'project:staffing-set', 'app:info', 'app:open-data-dir', 'update:get', 'update:check', 'update:download', 'update:install', 'scheduler:slots', 'seams:list', 'search:global', 'settings:get',
  'settings:set', 'settings:maintenance', 'settings:permission-list', 'settings:permission-revoke', 'skills:list', 'skills:set', 'task:approve', 'task:create', 'task:discard', 'task:edit-plan', 'task:export', 'task:get', 'task:list',
  'task:diff', 'task:merge', 'task:rework-merge-conflict', 'task:read-artifact', 'task:read-tool-output', 'task:reference-artifact', 'task:rollback', 'task:transition', 'ui:mounted',
  // 2026-10-16 替换批·壳层重排：自绘三键 handler（有意新增；冻结数随批 +3）。
  'ui:win-close', 'ui:win-is-maximized', 'ui:win-minimize', 'ui:win-toggle-maximize',
].sort();

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (e.name.endsWith('.ts')) acc.push(full);
  }
  return acc;
}

function matchAll(text: string, patterns: RegExp[]): Set<string> {
  const out = new Set<string>();
  for (const re of patterns) for (const m of text.matchAll(re)) out.add(m[1] as string);
  return out;
}

export function readPreloadChannels(): string[] {
  const t = readFileSync(join(ROOT, 'src', 'preload', 'index.ts'), 'utf8');
  return [...matchAll(t, [/invoke\('([^']+)'/g, /\.send\('([^']+)'/g])].sort();
}

export function readIpcChannels(): string[] {
  const out = new Set<string>();
  for (const f of walk(join(ROOT, 'src', 'main'))) {
    for (const ch of matchAll(readFileSync(f, 'utf8'), [/ipcMain\.handle\('([^']+)'/g, /ipcMain\.on\('([^']+)'/g])) out.add(ch);
  }
  return [...out].sort();
}

/** 集合差异（缺 / 多）。 */
export function diffSets(actual: string[], expected: string[]): { missing: string[]; extra: string[] } {
  const a = new Set(actual);
  const e = new Set(expected);
  return {
    missing: [...e].filter((x) => !a.has(x)).sort(),
    extra: [...a].filter((x) => !e.has(x)).sort(),
  };
}

// ── 关键契约常量（唯一真源，恰 1 处定义）──────────────────────
export interface ContractConstant {
  id: string;
  /** 定义所在文件（相对根）。 */
  file: string;
  re: RegExp;
  /** 缺席会导致什么（守卫失败信息里点名）。 */
  breaks: string;
  /** 是否必须**恰 1 处定义**（默认 true）；`false` = 只要求在场（如 kind 字符串多处引用）。 */
  unique?: boolean;
}

export const CONTRACT_CONSTANTS: ContractConstant[] = [
  { id: 'permission_question_prefix', file: 'src/main/db/approvals.ts', re: /PERMISSION_QUESTION_PREFIX\s*=\s*'\[权限\] '/, breaks: '权限审批行无法识别（AskCard 与权限审批混淆）' },
  { id: 'deviation_kind', file: 'src/main/ipc/deviation.ts', re: /DEVIATION_KIND\s*=\s*'deviation_recorded'/, breaks: '偏离台账读不到事件（收尾清零读数失效）' },
  { id: 'mailbox_err_not_impl', file: 'src/main/engine/mailbox.ts', re: /CHANNEL_NOT_IMPLEMENTED:\s*'E_CHANNEL_NOT_IMPLEMENTED'/, breaks: '未实现通道静默丢弃（丢消息）' },
  { id: 'mailbox_err_unknown', file: 'src/main/engine/mailbox.ts', re: /CHANNEL_UNKNOWN:\s*'E_CHANNEL_UNKNOWN'/, breaks: '未知通道无可判别错误' },
  { id: 'mailbox_err_blocking', file: 'src/main/engine/mailbox.ts', re: /BLOCKING_NOT_IMPLEMENTED:\s*'E_BLOCKING_NOT_IMPLEMENTED'/, breaks: '阻塞式提问被默默降级' },
  { id: 'task_id_prefix', file: 'src/core/short-id.ts', re: /TASK_ID_PREFIX\s*=\s*'T-'/, breaks: '短号格式错乱（IM 寻址失效）' },
  { id: 'task_id_start', file: 'src/core/short-id.ts', re: /TASK_ID_START\s*=\s*1001/, breaks: '短号起始区间漂移' },
  { id: 'seam_boundaries', file: 'src/main/seams/boundaries.ts', re: /SEAM_BOUNDARIES\s*=/, breaks: '接缝矩阵枚举真源丢失' },
  { id: 'kind_question_asked', file: 'schema.sql', re: /question_asked/, breaks: 'mailbox 消息主体 kind 未登记', unique: false },
  { id: 'kind_question_answered', file: 'schema.sql', re: /question_answered/, breaks: 'mailbox 回答 kind 未登记', unique: false },
  { id: 'kind_action_failed', file: 'schema.sql', re: /action_failed/, breaks: '动作失败留痕 kind 未登记', unique: false },
];

/** 每个常量必须**在场**；`unique!==false` 的还必须**恰好 1 处定义**（防“第三套”）。 */
export function checkContractConstants(sources: Iterable<[string, string]>): string[] {
  const issues: string[] = [];
  const files = [...sources];
  for (const c of CONTRACT_CONSTANTS) {
    const hits = files.reduce((n, [, text]) => n + [...text.matchAll(new RegExp(c.re, 'g'))].length, 0);
    if (hits === 0) issues.push(`${c.id}: 缺席 → ${c.breaks}`);
    else if (c.unique !== false && hits > 1) issues.push(`${c.id}: 出现 ${hits} 处（应恰 1 处）`);
  }
  return issues;
}

function allSources(): [string, string][] {
  const out: [string, string][] = walk(join(ROOT, 'src')).map((f) => [relative(ROOT, f).replace(/\\/g, '/'), readFileSync(f, 'utf8')]);
  out.push(['schema.sql', readFileSync(join(ROOT, 'schema.sql'), 'utf8')]);
  return out;
}

test('OPT-M2-3 struct-preload-count: preload 暴露 channel 恰好 100 个（冻结；B3-5 新增 memory:confirm；少一处即静默 reject）', () => {
  const actual = readPreloadChannels();
  const { missing, extra } = diffSets(actual, PRELOAD_CHANNELS);
  assert.equal(actual.length, 100, `preload 暴露数应为 96，实际 ${actual.length}`);
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] }, `preload channel 面漂移：缺=${missing} 多=${extra}`);
});

test('OPT-M2-3 struct-ipc-count: 主进程 IPC 注册 channel 恰好 100 个（冻结；B3-5 新增 memory:confirm；缺即 handler 缺失）', () => {
  const actual = readIpcChannels();
  const { missing, extra } = diffSets(actual, IPC_CHANNELS);
  assert.equal(actual.length, 100, `IPC 注册数应为 96，实际 ${actual.length}`);
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] }, `IPC 注册面漂移：缺=${missing} 多=${extra}`);
});

test('OPT-M2-3 struct-constants: 关键契约常量在场（缺席点名后果）', () => {
  const issues = checkContractConstants(allSources());
  assert.deepEqual(issues, [], `契约常量问题：\n${issues.join('\n')}`);
});

// ── struct-pi-import（d58f6ff 抓的静默降级 bug；并入 guard-matrix）──
/**
 * `src/main/**` **不得对 `@earendil-works/*` 做静态值导入**（只许动态 `import()` 或 `import type`）。
 * 原因：上游 ESM-only、主进程 CJS → 静态值导入被打成 `require()` → `No "exports" main defined`，
 * 且**失败是静默降级**（工具注册不上）。返回违规 `文件:行` 列表。
 */
export function checkNoStaticPiImports(sources: Iterable<[string, string]>): string[] {
  const issues: string[] = [];
  const re = /^\s*import\s+(?!type\b)[^;]*from\s+['"]@earendil-works\//;
  const bare = /^\s*import\s+['"]@earendil-works\//;
  for (const [file, text] of sources) {
    if (!/^src\/main\//.test(file)) continue;
    text.split('\n').forEach((line, i) => {
      if (re.test(line) || bare.test(line)) issues.push(`${file}:${i + 1}`);
    });
  }
  return issues;
}

test('OPT-M2-3 struct-pi-import: src/main 不得静态值导入 @earendil-works/*（只许动态 import / import type）', () => {
  const issues = checkNoStaticPiImports(allSources());
  assert.deepEqual(issues, [], `静态值导入 @earendil-works/*（CJS 下会 require → 静默降级）：\n${issues.join('\n')}`);
});

test('OPT-M2-3 "有牙": 删/加 channel、缺常量 → 必红（合成，证明上述断言有意义）', () => {
  // ① 面：缺一处 / 多一处
  assert.deepEqual(diffSets(['a', 'b'], ['a', 'b', 'c']).missing, ['c']);
  assert.deepEqual(diffSets(['a', 'b', 'x'], ['a', 'b']).extra, ['x']);
  // ② 常量：删掉定义 → 报缺席且点名后果
  const sans = allSources().filter(([f]) => f !== 'src/main/db/approvals.ts');
  const issues = checkContractConstants(sans);
  assert.ok(issues.some((i) => i.startsWith('permission_question_prefix') && /无法识别/.test(i)), JSON.stringify(issues));
  // ③ 常量：重复定义 → 报"应恰 1 处"
  const dup = [...allSources(), ['src/main/db/dup.ts', "export const TASK_ID_PREFIX = 'T-';"] as [string, string]];
  assert.ok(checkContractConstants(dup).some((i) => /task_id_prefix: 出现 2 处/.test(i)));
});

// ── OPT-M2-3 后续（M2 尾）：结构门覆盖面扩展 ─────────────────────────────
// 新目录/新迁移必须显式登记；不登记即红（防"新物绕过门禁"）。改动即触发复核，有意为之。
export const KNOWN_MAIN_DIRS = [
  'agent',
  'audit',
  'company',
  'db',
  'docs',
  'engine',
  'eval',
  'git',
  'im',
  'ipc',
  'memory',
  'notify',
  'permission',
  'seams',
  'security',
  'tray',
  'triggers',
].sort();

test('OPT-M2-3 struct-main-dirs: src/main 顶层目录全部登记（新目录即红）', () => {
  const actual = readdirSync(join(ROOT, 'src', 'main'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  assert.deepEqual(actual, KNOWN_MAIN_DIRS, '新增/删除 src/main 顶层目录须同批更新 KNOWN_MAIN_DIRS');
});

test('OPT-M2-3 struct-migrations: 每个 .sql 迁移都已在 loadMigrations 登记（无孤儿迁移）', () => {
  const files = readdirSync(join(ROOT, 'src', 'main', 'db', 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const registered = loadMigrations()
    .map((m) => m.file)
    .sort();
  assert.deepEqual(files, registered, '新增迁移须同时加 .sql/.ts 并在 migrations.ts 登记');
});
