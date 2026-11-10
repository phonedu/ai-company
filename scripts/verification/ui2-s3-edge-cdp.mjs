// 项目页运行/产物页签·边界验证配方（2026-11-10）：覆盖主配方没造到的五种真数据。
//
//  A. 员工现场（真 hall 查询）：应用启动后（避开启动恢复）写入两个 running 工作项（员工甲/乙），
//     刷新页面走真 `hall:state` 查询：项目 1 只应显示甲、项目 2 只应显示乙；
//  B. 变更历史非空：seed 一条 merged 变更集，展开折叠能看到行与摘要；
//  C. 跨项目引用产物：artifact.origin_project_id 指向项目 2 → UI 显示「来自 来源项目」；
//  D. 记忆页签写操作：真实点击「记住」→ 行出现 → 杀进程后回读 DB；
//  E. 大项目性能：seed 40 个任务，记录运行页签从点击到加载完成/行渲染的毫秒数（>300ms 记优化项，不阻断）。
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
const ud = `${TMP}/aico-ui2-s3-edge`;
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
let evalIn = null;
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
  for (const table of ['artifacts', 'changesets', 'memory_items', 'notifications', 'reports', 'approvals', 'plan_steps', 'task_events', 'work_items', 'tasks']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  db.prepare('DELETE FROM projects').run();
  db.prepare('DELETE FROM employees').run();
  db.prepare('INSERT INTO projects(id, name, root_dir, created_at, archived) VALUES(1,?,?,?,0)').run('边界样例', root, AT);
  db.prepare('INSERT INTO projects(id, name, root_dir, created_at, archived) VALUES(2,?,?,?,0)').run('来源项目', root, AT + 1);
  db.prepare("INSERT INTO employees(id,name,role,capability_tier,created_at) VALUES(11,'甲','开发','standard',1)").run();
  db.prepare("INSERT INTO employees(id,name,role,capability_tier,created_at) VALUES(12,'乙','开发','standard',1)").run();
  const insertTask = db.prepare(
    `INSERT INTO tasks(id, short_id, project_id, title, goal, acceptance, state, priority, risk_level, origin, cost_tokens, archived, created_at, updated_at)
     VALUES(?,?,?,?,?,'[]',?,0,1,'boss',0,0,?,?)`,
  );
  insertTask.run(1, 'T-4101', 1, '甲在跑的任务', '种子', 'executing', AT, AT + 10);
  insertTask.run(2, 'T-4102', 1, '有变更与引用产物的任务', '种子', 'done', AT, AT + 9);
  insertTask.run(3, 'T-4201', 2, '乙在跑的任务', '种子', 'executing', AT, AT + 8);
  // 40 个任务用于性能读数（每个一条未完成步骤）。
  for (let i = 0; i < 40; i += 1) {
    insertTask.run(100 + i, `T-51${String(i).padStart(2, '0')}`, 1, `批量任务 ${i + 1}`, '种子', 'executing', AT, AT + 2);
  }
  const insertStep = db.prepare('INSERT INTO plan_steps(task_id, idx, text, state, created_at, updated_at) VALUES(?,?,?,?,?,?)');
  insertStep.run(1, 1, '甲的工作项', 'running', AT, AT);
  insertStep.run(3, 1, '乙的工作项', 'running', AT, AT);
  for (let i = 0; i < 40; i += 1) insertStep.run(100 + i, 1, `批量步骤 ${i + 1}`, 'pending', AT, AT);
  // 注意：**不在此处 seed running 工作项**——引擎启动恢复会把 running 件判为 interrupted 并重派，
  // 反而把任务跑成 failed（上一轮实测 attempt=3、task.state=failed）。真运行态改在启动后再写入。
  // 变更集（非空折叠）＋ 跨项目引用产物。
  db.prepare(
    `INSERT INTO changesets(task_id, branch, base_sha, head_sha, files_changed, insertions, deletions, summary, commit_msg, state, created_at, merged_at)
     VALUES(2,'aico/T-4102','${'a'.repeat(40)}','${'b'.repeat(40)}',3,42,7,?,'edge: 边界变更','merged',?,?)`,
  ).run('边界变更：合并三条改动', AT + 20, AT + 30);
  db.prepare(
    "INSERT INTO artifacts(task_id, path, kind, note, sha256, origin_artifact_id, origin_project_id, created_at) VALUES(2,'docs/from-other.md','file','来自来源项目',? , NULL, 2, ?)",
  ).run('e'.repeat(64), AT + 25);
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
  evalIn = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }))?.result?.result?.value;
  const waitFor = async (expr, label, tries = 120) => {
    for (let i = 0; i < tries; i += 1) {
      if ((await evalIn(expr)) === true) return;
      await sleep(300);
    }
    throw new Error(`等待超时：${label}`);
  };
  const click = (sel) => evalIn(`document.querySelector('${sel}').click()`);
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(EVIDENCE, name), Buffer.from(r.result.data, 'base64'));
    findings.shots.push(join(EVIDENCE, name));
  };

  await waitFor("!!(window.api && document.querySelector('[data-testid=leftrail-projects]'))", '页面就绪');
  // A0. 真运行态：应用已起、启动恢复已过，此刻写入 running 工作项 → 刷新页面后由真 hall 查询读出。
  {
    const wdb = new Database(dbFile);
    wdb.pragma('busy_timeout = 3000');
    const ins = wdb.prepare(
      'INSERT INTO work_items(task_id, employee_id, title, brief, state, attempt, created_at, started_at) VALUES(?,?,?,?,?,0,?,?)',
    );
    const AT2 = Date.now();
    ins.run(1, 11, '甲在跑的任务', '种子', 'running', AT2, AT2);
    ins.run(3, 12, '乙在跑的任务', '种子', 'running', AT2, AT2);
    wdb.close();
  }
  await send('Page.reload', { ignoreCache: false });
  await sleep(1000);
  await waitFor("!!(window.api && document.querySelector('[data-testid=leftrail-projects]'))", '页面重载就绪');
  await click('[data-testid=leftrail-projects]');
  await waitFor("document.querySelectorAll('[data-testid=ptree-group]').length >= 2", '项目列表');
  await click('[data-testid=ptree-group][data-project-id="1"]');
  await waitFor("!!document.querySelector('[data-testid=project-tab-runs]')", '项目页');

  // A. 员工现场（项目 1 只显示甲）
  await waitFor("(document.querySelector('[data-testid=project-now-live]')?.textContent||'').includes('甲')", '员工现场格');
  const live1 = await evalIn("document.querySelector('[data-testid=project-now-live]')?.textContent ?? null");
  findings.steps.push({ step: '员工现场-项目1', value: live1 });
  await shot('s3-edge-now.png');

  // B. 大项目性能：**首次**进运行页签（冷加载 42 个任务的 list＋逐任务 get）计时。
  const perf = await evalIn(`(async () => {
    const t0 = performance.now();
    document.querySelector('[data-testid=project-tab-runs]').click();
    for (let i = 0; i < 600; i += 1) {
      const rows = document.querySelectorAll('[data-testid=project-runs-row]').length;
      const loading = document.querySelector('[data-testid=project-runs-loading]');
      if (!loading && rows > 0) return { ms: Math.round(performance.now() - t0), rows };
      await new Promise((r) => setTimeout(r, 50));
    }
    return { ms: Math.round(performance.now() - t0), rows: document.querySelectorAll('[data-testid=project-runs-row]').length, timeout: true };
  })()`);
  findings.steps.push({ step: '大项目性能', value: perf });
  await waitFor("!!document.querySelector('[data-testid=project-runs-history]')", '变更历史折叠');
  await evalIn("document.querySelector('[data-testid=project-runs-history] summary').click()");
  await waitFor("document.querySelectorAll('[data-testid=project-history-row]').length >= 1", '变更历史行');
  findings.steps.push({
    step: '变更历史',
    value: await evalIn(`(() => ({
      rows: document.querySelectorAll('[data-testid=project-history-row]').length,
      text: document.querySelector('[data-testid=project-runs-history]')?.textContent ?? null,
    }))()`),
  });
  await shot('s3-edge-runs.png');
  // 折叠区在长列表下方：滚到可见再截一张，作为「非空变更历史布局」证据。
  await evalIn("document.querySelector('[data-testid=project-runs-history]').scrollIntoView({ block: 'center' })");
  await sleep(300);
  await shot('s3-edge-history.png');

  // C. 跨项目引用产物「来自 X」
  await click('[data-testid=project-tab-artifacts]');
  await waitFor("document.querySelectorAll('[data-testid=project-artifacts-group]').length >= 1", '产物行');
  findings.steps.push({
    step: '跨项目引用',
    value: await evalIn("document.querySelector('[data-testid=project-artifacts-list]')?.textContent ?? null"),
  });
  await shot('s3-edge-artifacts.png');

  // D. 记忆页签写操作
  await click('[data-testid=project-tab-memory]');
  await waitFor("!!document.querySelector('[data-testid=project-memory-tab] [data-testid=project-memory]')", '记忆页');
  await evalIn(`(() => {
    const input = document.querySelector('[data-testid=project-memory-input]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '边界验证：对账单以万元为单位');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(200);
  await click('[data-testid=project-memory-add]');
  await waitFor("(document.querySelector('[data-testid=project-memory-list]')?.textContent||'').includes('对账单以万元为单位')", '记忆写入上屏', 160);
  findings.steps.push({
    step: '记忆写入',
    value: await evalIn("document.querySelector('[data-testid=project-memory-list]')?.textContent ?? null"),
  });
  await shot('s3-edge-memory.png');

  // 切项目 2：员工现场应只剩乙（等文案真变，防读到旧项目残留）。
  await click('[data-testid=leftrail-projects]');
  await waitFor("document.querySelectorAll('[data-testid=ptree-group]').length >= 2", '项目列表(切项目)');
  await click('[data-testid=ptree-group][data-project-id="2"]');
  await waitFor("!!document.querySelector('[data-testid=project-tab-runs]')", '项目2页');
  await waitFor("(document.querySelector('[data-testid=project-now-live]')?.textContent||'').includes('乙')", '项目2员工现场');
  findings.steps.push({ step: '员工现场-项目2', value: await evalIn("document.querySelector('[data-testid=project-now-live]')?.textContent ?? null") });
  await shot('s3-edge-project2.png');

  const steps = Object.fromEntries(findings.steps.map((s) => [s.step, s.value]));
  findings.ok =
    String(steps['员工现场-项目1'] ?? '').includes('甲') &&
    !String(steps['员工现场-项目1'] ?? '').includes('乙') &&
    String(steps['员工现场-项目2'] ?? '').includes('乙') &&
    !String(steps['员工现场-项目2'] ?? '').includes('甲') &&
    (steps['变更历史']?.rows ?? 0) >= 1 &&
    String(steps['变更历史']?.text ?? '').includes('边界变更') &&
    String(steps['跨项目引用'] ?? '').includes('来自 来源项目') &&
    String(steps['记忆写入'] ?? '').includes('对账单以万元为单位') &&
    (steps['大项目性能']?.rows ?? 0) >= 41;
} catch (error) {
  findings.error = error instanceof Error ? `${error.message}\n${error.stack ?? ''}`.slice(0, 1500) : String(error);
  // 失败现场取证：三格 DOM／hall 员工活动／项目任务数（便于定位是数据、查询还是渲染问题）。
  try {
    if (evalIn) {
      findings.diag = await evalIn(`(async () => ({
        now: document.querySelector('[data-testid=project-now]')?.outerHTML?.slice(0, 4000) ?? null,
        hall: (await window.api.hall.state())?.employees?.map((e) => ({
          id: e.id, name: e.name, status: e.activity?.status ?? null, taskId: e.activity?.taskId ?? null,
        })) ?? null,
        tasks: (await window.api.task.list({ projectId: 1, includeArchived: true }))?.length ?? null,
        loc: location.hash,
      }))()`);
    }
  } catch (diagError) {
    findings.diag = { error: diagError instanceof Error ? diagError.message : String(diagError) };
  }
} finally {
  killTree(pid);
  await sleep(1000);
  // 记忆写操作回读 DB（进程已关）。
  try {
    const db = new Database(`${ud}/aico.sqlite`, { readonly: true, fileMustExist: true });
    findings.db = db
      .prepare("SELECT scope_type, scope_id, kind, value FROM memory_items WHERE value LIKE '%对账单以万元为单位%'")
      .all();
    db.close();
  } catch (error) {
    findings.db = { error: error instanceof Error ? error.message : String(error) };
  }
  findings.pass = findings.ok === true && Array.isArray(findings.db) && findings.db.length === 1 && findings.db[0].scope_type === 'project' && findings.db[0].scope_id === 1;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(join(EVIDENCE, `s3-edge-result-${stamp}.json`), JSON.stringify(findings, null, 2), 'utf8');
  console.log(JSON.stringify(findings, null, 2));
  process.exit(findings.pass ? 0 : 1);
}
