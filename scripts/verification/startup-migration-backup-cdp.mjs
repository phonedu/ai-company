//  真机配方：迁移前自动备份＋迁移失败 fail-closed（不带着坏库开窗）。
//
// 步骤：
//   ① 首次启动建库（跑到最新版本）→ 优雅退出；
//   ② 手术：删掉最新迁移的账本行并把 user_version 退一版（模拟「库落后一版」）；
//      最新迁移 022 是 `ALTER TABLE projects ADD COLUMN`，重放会因 duplicate column 抛错——正好当毒迁移；
//   ③ 再次启动（AICO_STARTUP_FAIL_SILENT=1 跳过模态框）：期望**非 0 退出**（不进入窗口/引擎）；
//   ④ 断言：`<userData>/backups/aico-before-v22-*.sqlite` 已生成且非空；原库仍可打开、
//      迁移是事务性的（failed 迁移没有留下半截 schema）；备份只留 ≤3 份。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const REPO = process.cwd();
const require = createRequire(`${REPO}\\package.json`);
const Database = require('better-sqlite3');
const ELECTRON = join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe');
const ud = join(process.env.TEMP ?? '.', 'aico-migfail');
const port = 9494;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
rmTree(ud);
const dbFile = join(ud, 'aico.sqlite');

function rmTree(dir) {
  spawnSync('cmd', ['/c', 'rmdir', '/S', '/Q', dir], { stdio: 'ignore' });
}

const env = (extra) => ({ ...process.env, AICO_USER_DATA_DIR: ud, ...extra });
const args = () => ['.', `--user-data-dir=${ud}`, `--remote-debugging-port=${port}`];

/** 起一个实例，等页面就绪后优雅关闭（Browser.close）；返回 pid。 */
async function bootAndClose() {
  const child = spawn(ELECTRON, args(), { cwd: REPO, stdio: 'ignore', env: env() });
  let page = null;
  for (let i = 0; i < 80 && !page; i += 1) {
    await sleep(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null;
    } catch {
      /* not ready */
    }
  }
  if (!page) throw new Error('首启未就绪（无 CDP page）');
  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const bws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('browser ws timeout')), 5000);
    bws.onopen = () => {
      clearTimeout(t);
      res();
    };
    bws.onerror = (e) => {
      clearTimeout(t);
      rej(e);
    };
  });
  bws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
  await sleep(2500);
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  await sleep(800);
}

try {
  const problems = [];
  await bootAndClose();
  if (!existsSync(dbFile)) throw new Error('首启没有建库（路径不对？）');

  // ② 模拟落后一版：删 022 账本行 + user_version 退到 21。
  {
    const db = new Database(dbFile);
    const latest = Number(db.pragma('user_version', { simple: true })) || 0;
    db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(latest);
    db.pragma(`user_version = ${latest - 1}`);
    db.close();
    console.log(`[migfail] 手术完成：user_version=${latest - 1}，ledger 缺 v${latest}`);
  }

  // ③ 再启动：期望 fail-closed（非 0 退出，不开窗/不进引擎）。
  const child = spawn(ELECTRON, args(), {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: env({ AICO_STARTUP_FAIL_SILENT: '1' }),
  });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += String(d);
  });
  child.stdout.on('data', (d) => {
    stderr += String(d);
  });
  const exit = await new Promise((resolve) => {
    const t = setTimeout(() => resolve({ timeout: true }), 30000);
    child.on('exit', (code) => {
      clearTimeout(t);
      resolve({ code });
    });
  });
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  console.log('[migfail] exit=' + JSON.stringify(exit));
  if (exit.timeout) problems.push('迁移失败后进程没有退出（fail-closed 未生效/被模态框阻塞）');
  else if (exit.code === 0) problems.push('迁移失败却以 0 退出（会带着坏库开窗）');
  if (!/迁移前备份\/迁移失败|duplicate column/i.test(stderr)) {
    problems.push('日志里没有迁移失败原因（不可诊断）');
  }

  // ④ 备份 + 原库完整性
  const backupsDir = join(ud, 'backups');
  const backups = existsSync(backupsDir)
    ? readdirSync(backupsDir).filter((f) => f.startsWith('aico-before-v') && f.endsWith('.sqlite'))
    : [];
  console.log('[migfail] backups=' + JSON.stringify(backups));
  if (backups.length === 0) problems.push('迁移前没有生成自动备份');
  if (backups.length > 3) problems.push(`备份超过保留上限：${backups.length}`);
  for (const b of backups) {
    if (statSync(join(backupsDir, b)).size <= 0) problems.push(`备份 ${b} 是空文件`);
  }
  const check = new Database(dbFile, { readonly: true, fileMustExist: true });
  const version = Number(check.pragma('user_version', { simple: true }));
  const hasColumn = check.prepare('PRAGMA table_info(projects)').all().some(
    (c) => c.name === 'target_branch',
  );
  const projects = check.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='projects'").get().n;
  check.close();
  console.log(`[migfail] db user_version=${version} target_branch=${hasColumn} projects_table=${projects}`);
  if (version !== 21) problems.push(`失败迁移不得推进 user_version（实际 ${version}）`);
  if (projects !== 1) problems.push('失败后原库结构受损（projects 表丢失）');

  if (problems.length > 0) throw new Error('B0-12 迁移 fail-closed 真机断言未过：\n  - ' + problems.join('\n  - '));
  console.log(
    '[migfail] PASS：落后一版 → 先备份（v1 非空）→ 毒迁移抛错 → 非 0 退出（不开窗）→ 原库结构完好、version 未推进',
  );
} catch (error) {
  console.error('[migfail] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  rmTree(ud);
}
