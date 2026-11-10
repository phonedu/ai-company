// 运行/产物页签 真机配方（2026-11-10）：项目页「三格＋运行/产物/记忆页签」。
//
// 断言：
//  ① 五页签在场（任务/运行/产物/记忆/设置）；
//  ② 三格真数据：进展（1 进行中/1 等待/1 已完成，标「自动摘要」）＋待拍板 1 张（点击深链到任务详情）；
//  ③ 「运行」= 活跃工作项只读列表（跑/待开始步骤）＋变更历史折叠；
//  ④ 「产物」= 跨任务拼装、同路径多版本折叠（旧版本 1 条）；
//  ⑤ 「记忆」= 独立页签；设置组不再含「记忆」（7 组）；
//  ⑥ 切到空项目：三格不渲染、运行/产物为空态、缓存不串项目。
// 隔离：临时 userData＋CDP 9498；不读写真实数据目录；不跑模型。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const REPO = process.cwd();
const require = createRequire(`${REPO}\\package.json`);
const Database = require('better-sqlite3');
const ELECTRON = `${REPO}\\node_modules\\electron\\dist\\electron.exe`;
const EVIDENCE = process.env.AICO_UI_EVIDENCE_DIR?.trim() || 'C:\\Project\\ai-company\\history\\records\\realworld\\ui2-s3';
const TMP = String(process.env.TEMP || '').replace(/\\/g, '/');
const ud = `${TMP}/aico-ui2-s3`;
const root = `${ud}/project`;
const port = 9498;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
rmSync(ud, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
mkdirSync(EVIDENCE, { recursive: true });

const start = () =>
  spawn(ELECTRON, ['.', `--user-data-dir=${ud}`, `--remote-debugging-port=${port}`], {
    cwd: REPO,
    stdio: 'ignore',
    env: { ...process.env, AICO_USER_DATA_DIR: ud, AICO_DEFAULT_PROJECT_ROOT: root },
  }).pid;
const killTree = (pid) => spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });

const MIGRATION_MAX = Math.max(
  ...readdirSync(join(REPO, 'src', 'main', 'db', 'migrations'))
    .filter((f) => f.endsWith('.sql'))
    .map((f) => Number(f.split('_')[0]))
    .filter((n) => Number.isFinite(n)),
);

const findings = { steps: [], shots: [] };
let pid = start();
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
  killTree(pid);
  await sleep(1200);

  const AT = Date.now();
  const db = new Database(dbFile);
  db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('onboarding.completed','true')").run();
  for (const table of ['notifications', 'reports', 'approvals', 'plan_steps', 'task_events', 'work_items', 'tasks']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  db.prepare('DELETE FROM projects').run();
  db.prepare('INSERT INTO projects(id, name, root_dir, created_at, archived) VALUES(1,?,?,?,0)').run('S3 样例项目', root, AT);
  db.prepare('INSERT INTO projects(id, name, root_dir, created_at, archived) VALUES(2,?,?,?,0)').run('S3 空项目', root, AT + 1);
  const insertTask = db.prepare(
    `INSERT INTO tasks(id, short_id, project_id, title, goal, acceptance, state, priority, risk_level, origin, cost_tokens, archived, created_at, updated_at)
     VALUES(?,?,?,?,?,'[]',?,0,1,'boss',0,0,?,?)`,
  );
  insertTask.run(1, 'T-3001', 1, '正在执行的任务', '种子', 'executing', AT, AT + 10);
  insertTask.run(2, 'T-3002', 1, '等老板拍板的任务', '种子', 'needs_decision', AT, AT + 9);
  insertTask.run(3, 'T-3003', 1, '已完成的任务', '种子', 'done', AT, AT + 8);
  const insertStep = db.prepare(
    'INSERT INTO plan_steps(task_id, idx, text, state, created_at, updated_at) VALUES(?,?,?,?,?,?)',
  );
  insertStep.run(1, 1, '搭骨架', 'done', AT, AT);
  insertStep.run(1, 2, '实现主流程', 'running', AT, AT);
  insertStep.run(1, 3, '自测', 'pending', AT, AT);
  const insertArtifact = db.prepare(
    'INSERT INTO artifacts(task_id, path, kind, note, sha256, created_at) VALUES(?,?,?,?,?,?)',
  );
  insertArtifact.run(3, 'docs/spec.md', 'doc', '第一版规格', 'a'.repeat(64), AT + 100);
  insertArtifact.run(3, 'docs/spec.md', 'doc', '修订版规格', 'b'.repeat(64), AT + 200);
  insertArtifact.run(3, 'assets/cover.png', 'image', '封面', 'c'.repeat(64), AT + 150);
  db.prepare(
    `INSERT INTO reports(task_id, kind, payload, state, dedupe_key, created_at)
     VALUES(2,'ask',?,'pending',?,?)`,
  ).run(JSON.stringify({ title: '需要你拍板：选方案 A 还是 B', question: 'A/B' }), `s3-recipe:${AT}`, AT + 300);
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
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(EVIDENCE, name), Buffer.from(r.result.data, 'base64'));
    findings.shots.push(join(EVIDENCE, name));
  };

  await waitFor("!!(window.api && document.querySelector('[data-testid=leftrail-projects]'))", '页面就绪');
  await evalIn("document.querySelector('[data-testid=leftrail-projects]').click()");
  await waitFor("document.querySelectorAll('[data-testid=ptree-group]').length >= 2", '项目列表');
  await evalIn("document.querySelectorAll('[data-testid=ptree-group]')[0].click()");
  await waitFor("!!document.querySelector('[data-testid=project-tab-runs]')", '项目页五页签');
  findings.steps.push({
    step: '页签',
    value: await evalIn("Array.from(document.querySelectorAll('[data-testid^=project-tab-]')).map((b) => b.textContent.trim())"),
  });

  // 三格
  await waitFor("!!document.querySelector('[data-testid=project-now-progress]')", '三格·进展');
  findings.steps.push({
    step: '三格',
    value: await evalIn(`(() => ({
      progress: document.querySelector('[data-testid=project-now-progress]')?.textContent ?? null,
      pending: document.querySelector('[data-testid=project-now-pending-link]')?.textContent ?? null,
      badge: document.querySelector('[data-testid=project-now-progress]')?.textContent?.includes('自动摘要') ?? false,
    }))()`),
  });
  await shot('s3-project-now.png');

  // 待拍板深链 → 任务详情
  await evalIn("document.querySelector('[data-testid=project-now-pending-link]').click()");
  await waitFor("!!document.querySelector('[data-testid=task-detail]')", '待拍板深链到任务详情');
  await evalIn("document.querySelector('[data-testid=leftrail-projects]').click()");
  await waitFor("document.querySelectorAll('[data-testid=ptree-group]').length >= 2", '回到项目树');
  await evalIn("document.querySelectorAll('[data-testid=ptree-group]')[0].click()");
  await waitFor("!!document.querySelector('[data-testid=project-tab-runs]')", '回到项目页');

  // 运行页签
  await evalIn("document.querySelector('[data-testid=project-tab-runs]').click()");
  await waitFor("!!document.querySelector('[data-testid=project-runs]')", '运行页签');
  await waitFor("document.querySelectorAll('[data-testid=project-runs-row]').length >= 2", '活跃工作项');
  findings.steps.push({
    step: '运行页签',
    value: await evalIn(`(() => ({
      rows: document.querySelectorAll('[data-testid=project-runs-row]').length,
      text: document.querySelector('[data-testid=project-runs]')?.textContent ?? null,
      history: !!document.querySelector('[data-testid=project-runs-history]'),
    }))()`),
  });
  await shot('s3-project-runs.png');

  // 产物页签
  await evalIn("document.querySelector('[data-testid=project-tab-artifacts]').click()");
  await waitFor("!!document.querySelector('[data-testid=project-artifacts]')", '产物页签');
  await waitFor("document.querySelectorAll('[data-testid=project-artifacts-group]').length >= 2", '产物分组');
  const artifacts = await evalIn(`(() => ({
    groups: document.querySelectorAll('[data-testid=project-artifacts-group]').length,
    older: document.querySelectorAll('[data-testid=project-artifacts-older]').length,
    text: document.querySelector('[data-testid=project-artifacts]')?.textContent ?? null,
  }))()`);
  findings.steps.push({ step: '产物页签', value: artifacts });
  await evalIn("document.querySelector('[data-testid=project-artifacts-older] summary').click()");
  await sleep(300);
  findings.steps.push({
    step: '旧版本展开',
    value: await evalIn("document.querySelectorAll('[data-testid=project-artifacts-old-row]').length"),
  });
  await shot('s3-project-artifacts.png');

  // 记忆 + 设置组
  await evalIn("document.querySelector('[data-testid=project-tab-memory]').click()");
  await waitFor("!!document.querySelector('[data-testid=project-memory-tab]')", '记忆页签');
  await evalIn("document.querySelector('[data-testid=project-tab-settings]').click()");
  await waitFor("!!document.querySelector('[data-testid=project-settings-groupnav]')", '设置组导航');
  findings.steps.push({
    step: '设置组',
    value: await evalIn("Array.from(document.querySelectorAll('[data-testid^=project-settings-groupnav-]')).map((b) => b.textContent.trim())"),
  });

  // 切空项目：三格不渲染、运行/产物空态
  await evalIn("document.querySelector('[data-testid=leftrail-projects]').click()");
  await waitFor("document.querySelectorAll('[data-testid=ptree-group]').length >= 2", '项目列表(切换)');
  await evalIn("document.querySelectorAll('[data-testid=ptree-group]')[1].click()");
  await waitFor("!!document.querySelector('[data-testid=project-tab-runs]')", '空项目页');
  const emptyProject = await evalIn(`(() => ({
    now: !!document.querySelector('[data-testid=project-now]'),
    nowProgress: !!document.querySelector('[data-testid=project-now-progress]'),
  }))()`);
  await evalIn("document.querySelector('[data-testid=project-tab-runs]').click()");
  await waitFor("!!document.querySelector('[data-testid=project-runs]')", '空项目运行页签');
  const emptyRuns = await evalIn("document.querySelectorAll('[data-testid=project-runs-row]').length");
  await evalIn("document.querySelector('[data-testid=project-tab-artifacts]').click()");
  await waitFor("!!document.querySelector('[data-testid=project-artifacts]')", '空项目产物页签');
  const emptyArtifacts = await evalIn("document.querySelectorAll('[data-testid=project-artifacts-group]').length");
  findings.steps.push({ step: '空项目', value: { ...emptyProject, runs: emptyRuns, artifacts: emptyArtifacts } });

  const steps = Object.fromEntries(findings.steps.map((s) => [s.step, s.value]));
  findings.ok =
    Array.isArray(steps['页签']) &&
    steps['页签'].length === 5 &&
    String(steps['三格']?.progress ?? '').includes('进行中 1') &&
    String(steps['三格']?.progress ?? '').includes('等待 1') &&
    String(steps['三格']?.progress ?? '').includes('已完成 1') &&
    steps['三格']?.badge === true &&
    String(steps['三格']?.pending ?? '').includes('1 张待你拍板') &&
    steps['运行页签']?.rows >= 2 &&
    String(steps['运行页签']?.text ?? '').includes('实现主流程') &&
    steps['运行页签']?.history === true &&
    steps['产物页签']?.groups === 2 &&
    steps['产物页签']?.older === 1 &&
    steps['旧版本展开'] === 1 &&
    Array.isArray(steps['设置组']) &&
    steps['设置组'].length === 7 &&
    !steps['设置组'].includes('记忆') &&
    steps['空项目']?.now === false &&
    steps['空项目']?.runs === 0 &&
    steps['空项目']?.artifacts === 0;
} catch (error) {
  findings.error = error instanceof Error ? `${error.message}\n${error.stack ?? ''}`.slice(0, 1500) : String(error);
} finally {
  killTree(pid);
  await sleep(800);
  findings.pass = findings.ok === true;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(join(EVIDENCE, `s3-result-${stamp}.json`), JSON.stringify(findings, null, 2), 'utf8');
  console.log(JSON.stringify(findings, null, 2));
  process.exit(findings.pass ? 0 : 1);
}
