// 150% 缩放真机验证（2026-11-10 老板：4K 屏没有，150% 可以）：用 Electron 的
// --force-device-scale-factor=1.5 让 Chromium 走**真实缩放管线**（物理 2x 屏上按 1.5 栅格化/布局），
// 不是 CDP 的 deviceScaleFactor 模拟。验证：dpr=1.5、零横向溢出、模型表单可开、主操作可见。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const REPO = process.cwd();
const require = createRequire(`${REPO}\\package.json`);
const Database = require('better-sqlite3');
const ELECTRON = `${REPO}\\node_modules\\electron\\dist\\electron.exe`;
const TMP = String(process.env.TEMP || '').replace(/\\/g, '/');
const ud = `${TMP}/aico-scale150`;
const root = `${ud}/project`;
const port = 9502;
const EVIDENCE = 'C:\\Project\\ai-company\\history\\records\\realworld\\ui2-s2-review';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
rmSync(ud, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const start = () =>
  spawn(ELECTRON, ['.', `--user-data-dir=${ud}`, `--remote-debugging-port=${port}`, '--force-device-scale-factor=1.5'], {
    cwd: REPO,
    stdio: 'ignore',
    env: { ...process.env, AICO_USER_DATA_DIR: ud, AICO_DEFAULT_PROJECT_ROOT: root },
  }).pid;
const kill = (p) => spawnSync('taskkill', ['/PID', String(p), '/T', '/F'], { stdio: 'ignore' });

const MIGRATION_MAX = Math.max(
  ...readdirSync(join(REPO, 'src', 'main', 'db', 'migrations'))
    .filter((f) => f.endsWith('.sql'))
    .map((f) => Number(f.split('_')[0]))
    .filter((n) => Number.isFinite(n)),
);
let pid = start();
const out = { ok: false };
try {
  const dbFile = `${ud}/aico.sqlite`;
  for (let i = 0; i < 180 && !existsSync(dbFile); i += 1) await sleep(500);
  let migrated = false;
  for (let i = 0; i < 180 && !migrated; i += 1) {
    try {
      const probe = new Database(dbFile, { readonly: true, fileMustExist: true });
      migrated = Number(probe.pragma('user_version', { simple: true })) >= MIGRATION_MAX;
      probe.close();
    } catch {
      /* migrating */
    }
    if (!migrated) await sleep(500);
  }
  if (!migrated) throw new Error('db not migrated');
  await sleep(800);
  kill(pid);
  await sleep(1200);
  const db = new Database(dbFile);
  db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('onboarding.completed','true')").run();
  for (const t of ['notifications', 'reports', 'approvals', 'plan_steps', 'task_events', 'work_items', 'tasks']) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare('DELETE FROM projects').run();
  db.prepare('INSERT INTO projects(id, name, root_dir, created_at, archived) VALUES(1,?,?,?,0)').run('150%缩放样例', root, Date.now());
  db.prepare(
    `INSERT INTO tasks(id, short_id, project_id, title, goal, acceptance, state, priority, risk_level, origin, cost_tokens, archived, created_at, updated_at)
     VALUES(1,'T-3001',1,'缩放样例任务','种子','[]','executing',0,1,'boss',0,0,?,?)`,
  ).run(Date.now(), Date.now());
  db.close();

  pid = start();
  let page = null;
  for (let i = 0; i < 120 && !page; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      page = pages.find((t) => String(t.url ?? '').includes('index.html')) ?? null;
    } catch {
      /* not ready */
    }
    if (!page) await sleep(500);
  }
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const cb = pending.get(m.id);
    if (cb) {
      pending.delete(m.id);
      cb(m);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res) => {
      const id = ++seq;
      const t = setTimeout(() => res({}), 15000);
      pending.set(id, (m) => {
        clearTimeout(t);
        res(m);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evalIn = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }))?.result?.result?.value;
  const waitFor = async (expr, label, tries = 100) => {
    for (let i = 0; i < tries; i += 1) {
      if ((await evalIn(expr)) === true) return;
      await sleep(300);
    }
    throw new Error(`等待超时：${label}`);
  };
  await waitFor("!!(window.api && document.querySelector('[data-testid=leftrail-projects]'))", '页面就绪');
  await evalIn("document.querySelector('[data-testid=leftrail-projects]').click()");
  await waitFor("!!document.querySelector('[data-testid=project-tab-settings]')", '项目页');
  await evalIn("document.querySelector('[data-testid=project-tab-settings]').click()");
  await waitFor("!!document.querySelector('[data-testid=project-model-card]')", '模型卡');
  await evalIn("document.querySelector('[data-testid=project-model-edit]').click()");
  await waitFor("!!document.querySelector('[data-testid=project-model-form]')", '模型表单');
  await sleep(700);
  out.metrics = await evalIn(`(() => {
    const btn = document.querySelector('[data-testid=project-model-save]').getBoundingClientRect();
    const ctl = document.querySelector('[data-testid=project-model-policy]').getBoundingClientRect();
    const summary = document.querySelector('[data-testid=project-model-summary] .project-view__model-summary');
    return {
      devicePixelRatio: window.devicePixelRatio,
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      scrollW: document.documentElement.scrollWidth,
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      saveVisible: btn.bottom <= window.innerHeight,
      controlLeft: Math.round(ctl.left),
      summaryFont: summary ? getComputedStyle(summary).fontSize : null,
      bodyBg: getComputedStyle(document.body).backgroundColor,
    };
  })()`);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const file = join(EVIDENCE, 'ui2-s2-scale150-physical.png');
  writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
  out.shot = file;
  out.ok =
    out.metrics?.devicePixelRatio === 1.5 &&
    out.metrics?.overflow === false &&
    out.metrics?.saveVisible === true &&
    out.metrics?.summaryFont === '15px';
} catch (error) {
  out.error = error instanceof Error ? `${error.message}\n${error.stack ?? ''}`.slice(0, 1200) : String(error);
} finally {
  kill(pid);
  writeFileSync(`${TMP}/aico-scale150-result.json`, JSON.stringify(out, null, 2), 'utf8');
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
}
