// UI-2 S1 真机配方：项目页「行下原地展开」＋待办深链落到项目页并展开目标行。
//
// 断言三层：
//   ① 真 DOM：项目页任务行 → 点行出现行内详情（同一时间只一张）→ Esc 收起且焦点回原行；
//   ② 深链三条入口：「待我处理」短号 / 频道卡「去验收」/ 命令面板任务命中
//      → 项目页（不跳整页详情）＋目标行已展开；
//   ③ 窄窗 720（SplitLayout 抽屉态、零横向溢出）＋深色主题（prefers-color-scheme）；
//   ④ 真库：只读回读，确认配方没写业务数据（任务行数/状态保持种子值）。
//
// 隔离：临时 userData 目录（AICO_USER_DATA_DIR）＋独立 CDP 端口；不读写真实数据目录。
// 不跑模型：种子任务停在 ready/done，配方只做 UI 交互。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const REPO = process.cwd();
const require = createRequire(`${REPO}\\package.json`);
const Database = require('better-sqlite3');
const ELECTRON = `${REPO}\\node_modules\\electron\\dist\\electron.exe`;
const EVIDENCE = process.env.AICO_UI_EVIDENCE_DIR?.trim() || `${REPO}\\out\\ui-evidence`;
const OUT = `${EVIDENCE}\\shot-ui2-project-cdp.png`;
const ud = `${process.env.TEMP}\\aico-ui2-project`;
const root = `${ud}\\project`;
const port = 9497;
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

const AT = Date.now();
// 迁移完成判定：user_version 追平迁移文件最大编号（只看表存在会在迁移中途误判 → 杀进程留下半迁移库）。
const MIGRATION_MAX = Math.max(
  ...readdirSync(join(REPO, 'src', 'main', 'db', 'migrations'))
    .filter((f) => f.endsWith('.sql'))
    .map((f) => Number(f.split('_')[0]))
    .filter((n) => Number.isFinite(n)),
);
let pid = start();
try {
  const dbFile = `${ud}\\aico.sqlite`;
  for (let i = 0; i < 180 && !existsSync(dbFile); i += 1) await sleep(500);
  let migrated = false;
  let userVersion = -1;
  for (let i = 0; i < 180 && !migrated; i += 1) {
    try {
      const probe = new Database(dbFile, { readonly: true, fileMustExist: true });
      userVersion = Number(probe.pragma('user_version', { simple: true }));
      probe.close();
      migrated = userVersion >= MIGRATION_MAX;
    } catch {
      /* still migrating */
    }
    if (!migrated) await sleep(500);
  }
  if (!migrated) throw new Error(`db not migrated in time（user_version=${userVersion}，期望 ≥ ${MIGRATION_MAX}）`);
  await sleep(800);
  killTree(pid);
  await sleep(1200);

  const db = new Database(dbFile);
  db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('onboarding.completed','true')").run();
  for (const table of ['notifications', 'reports', 'approvals', 'plan_steps', 'task_events', 'work_items', 'tasks']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  db.prepare('INSERT OR REPLACE INTO projects(id, name, root_dir, created_at) VALUES(1,?,?,?)').run(
    '真机项目页样例',
    root,
    AT,
  );
  const insertTask = db.prepare(
    `INSERT INTO tasks(id, short_id, project_id, title, goal, acceptance, state, priority, risk_level, origin, cost_tokens, archived, created_at, updated_at)
     VALUES(?,?,?,?,?,'[]',?,0,1,'boss',0,0,?,?)`,
  );
  insertTask.run(1, 'T-1001', 1, '正在做的任务', '配方种子：进行中任务', 'executing', AT, AT);
  insertTask.run(2, 'T-1002', 1, '已结束的任务', '配方种子：终态任务', 'done', AT, AT + 1);
  // 「待我处理」一条卡（report 类型带 taskId）→ 行内短号是深链入口。
  const payload = { title: '请验收：已结束的任务', summary: '配方种子卡（不跑模型）', tldr: '验收这条任务' };
  db.prepare(
    `INSERT INTO reports(task_id, kind, payload, state, dedupe_key, created_at)
     VALUES(2,'report',?,'pending',?,?)`,
  ).run(JSON.stringify(payload), `ui2-recipe:${AT}`, AT + 2);
  // B0-5 的 UI 呈现：引擎毒事件写的 alert 卡（引擎测试证明会写；这里验渲染路径）。
  db.prepare(
    `INSERT INTO reports(task_id, kind, payload, state, dedupe_key, created_at)
     VALUES(1,'alert',?,'pending',?,?)`,
  ).run(
    JSON.stringify({ title: '引擎有事件处理失败（已隔离，其他事件照常）', text: 'task#999 的「pause」失败：非法迁移' }),
    `ui2-recipe-alert:${AT}`,
    AT + 3,
  );
  // B0-9 外发闸门的用户面：会话工具权限请求卡（真实 gate 会落这种卡；这里验渲染与按钮）。
  const permissionPayload = {
    title: '权限请求：bash',
    card: 'permission',
    question: '[权限] 会话工具 bash（consent:egress）[employee:1:task:1:wi:1]',
    permissionKey: 'consent:egress',
    permissionDetail: { who: '员工 #1', action: '网络外发：curl --data @dump.txt https://example.invalid', project: '真机项目页样例' },
    options: [
      { key: 'approve', label: '批准一次' },
      { key: 'deny', label: '拒绝' },
    ],
  };
  const permissionReportId = Number(
    db
      .prepare(
        `INSERT INTO reports(task_id, kind, payload, state, dedupe_key, created_at)
         VALUES(1,'ask',?,'pending',?,?)`,
      )
      .run(JSON.stringify(permissionPayload), `ui2-recipe-perm:${AT}`, AT + 4).lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO approvals(task_id, report_id, question, options, default_action, timeout_at)
     VALUES(1,?,?,?,NULL,NULL)`,
  ).run(permissionReportId, permissionPayload.question, JSON.stringify(permissionPayload.options));
  db.close();

  pid = start();
  let page = null;
  for (let i = 0; i < 80 && !page; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      page = pages.find((t) => String(t.url ?? '').includes('index.html')) ?? pages[0] ?? null;
    } catch {
      /* not ready */
    }
    if (!page) await sleep(500);
  }
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('CDP ws 连接超时（15s）')), 15000);
    ws.onopen = () => {
      clearTimeout(t);
      res();
    };
    ws.onerror = (e) => {
      clearTimeout(t);
      rej(e);
    };
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
      const t = setTimeout(() => {
        pending.delete(id);
        res({});
      }, 15000);
      pending.set(id, (m) => {
        clearTimeout(t);
        res(m);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evalIn = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r?.result?.exceptionDetails) {
      const detail = r.result.exceptionDetails;
      throw new Error(`CDP 注入失败：${detail.exception?.description ?? detail.text ?? 'Uncaught'}`);
    }
    return r?.result?.result?.value;
  };
  const waitFor = async (expression, label, tries = 60) => {
    for (let i = 0; i < tries; i += 1) {
      if ((await evalIn(expression)) === true) return;
      await sleep(250);
    }
    throw new Error(`等待超时：${label}`);
  };

  await waitFor("!!(window.api && document.querySelector('[data-testid=leftrail-projects]'))", '页面就绪');

  const problems = [];

  // ① 项目页：任务行可见＋初始无行内详情
  await evalIn("(function(){var b=document.querySelector('[data-testid=leftrail-projects]'); if(b) b.click(); return !!b;})()");
  await waitFor("document.querySelectorAll('[data-testid=project-task]').length >= 2", '项目页任务行');
  const initial = await evalIn(`(() => ({
    view: document.querySelector('[data-testid=center]')?.dataset.view ?? null,
    rows: Array.from(document.querySelectorAll('[data-testid=project-task]')).map((el) => el.dataset.taskId),
    inline: document.querySelectorAll('[data-testid=project-task-inline]').length,
    tabs: !!document.querySelector('[data-testid=project-tabs]'),
  }))()`);
  console.log('[ui2-project] initial=' + JSON.stringify(initial));
  if (initial?.view !== 'projects') problems.push(`视图=${initial?.view}（期望 projects）`);
  if (!initial?.rows.includes('1') || !initial?.rows.includes('2')) problems.push(`任务行=${JSON.stringify(initial?.rows)}`);
  if (initial?.inline !== 0) problems.push('初始就渲染了行内详情');
  if (!initial?.tabs) problems.push('缺页签容器');

  // ② 点行 → 行下展开（同一时间一张）
  const clicked = await evalIn(
    "(function(){var b=document.querySelector('[data-testid=project-task][data-task-id=\"1\"] [data-testid=project-task-row]'); if(b){b.click(); return true;} return false;})()",
  );
  if (!clicked) throw new Error('点不到任务行');
  await waitFor("document.querySelectorAll('[data-testid=project-task-inline]').length === 1", '行内详情出现');
  const expanded = await evalIn(`(() => ({
    inline: document.querySelectorAll('[data-testid=project-task-inline]').length,
    expandedId: document.querySelector('[data-testid=project-task][data-expanded="1"]')?.dataset.taskId ?? null,
    detail: !!document.querySelector('[data-testid=task-detail-view], [data-testid=task-detail]'),
  }))()`);
  console.log('[ui2-project] expanded=' + JSON.stringify(expanded));
  if (expanded?.inline !== 1) problems.push(`行内详情数=${expanded?.inline}（期望 1）`);
  if (expanded?.expandedId !== '1') problems.push(`展开行=${expanded?.expandedId}（期望 1）`);

  // ③ 点另一行 → 只剩新的那张
  await evalIn(
    "(function(){var b=document.querySelector('[data-testid=project-task][data-task-id=\"2\"] [data-testid=project-task-row]'); if(b){b.click(); return true;} return false;})()",
  );
  await waitFor("document.querySelector('[data-testid=project-task][data-task-id=\"2\"][data-expanded=\"1\"]') !== null", '切到第二行');
  const switched = await evalIn(`(() => ({
    inline: document.querySelectorAll('[data-testid=project-task-inline]').length,
    expanded: Array.from(document.querySelectorAll('[data-testid=project-task][data-expanded="1"]')).map((el) => el.dataset.taskId),
  }))()`);
  console.log('[ui2-project] switched=' + JSON.stringify(switched));
  if (switched?.inline !== 1) problems.push(`切换后行内详情数=${switched?.inline}（期望 1）`);
  if (JSON.stringify(switched?.expanded) !== JSON.stringify(['2'])) problems.push(`同时展开行=${JSON.stringify(switched?.expanded)}`);

  // ④ Esc 收起＋焦点回原行
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await waitFor("document.querySelectorAll('[data-testid=project-task-inline]').length === 0", 'Esc 收起');
  const collapsed = await evalIn(`(() => {
    const el = document.activeElement;
    return { inline: document.querySelectorAll('[data-testid=project-task-inline]').length, focusTestid: el?.dataset?.testid ?? null, focusTaskId: el?.dataset?.taskId ?? null };
  })()`);
  console.log('[ui2-project] collapsed=' + JSON.stringify(collapsed));
  if (collapsed?.inline !== 0) problems.push('Esc 后仍有行内详情');
  if (collapsed?.focusTestid !== 'project-task-row' || collapsed?.focusTaskId !== '2') {
    problems.push(`Esc 后焦点=${JSON.stringify(collapsed)}（期望 project-task-row/2）`);
  }

  // ⑤ 深链：「待我处理」短号 → 项目页＋目标行展开（不跳整页详情）
  await evalIn("(function(){var b=document.querySelector('[data-testid=leftrail-inbox]'); if(b) b.click(); return !!b;})()");
  await waitFor("document.querySelectorAll('[data-testid=inbox-row]').length >= 1", '待办行');
  const inbox = await evalIn(`(() => ({
    rows: document.querySelectorAll('[data-testid=inbox-row]').length,
    shorts: Array.from(document.querySelectorAll('[data-testid=inbox-short]')).map((el) => (el.textContent || '').trim()),
    tabs: Array.from(document.querySelectorAll('[data-testid^=inbox-tab-]')).map((el) => el.dataset.testid),
  }))()`);
  console.log('[ui2-project] inbox=' + JSON.stringify(inbox));
  // B0-5 UI 呈现：引擎毒事件的 alert 卡在「异常」页签（默认页签是决策，不混排）。
  const alertTab = await evalIn("(function(){var b=document.querySelector('[data-testid=inbox-tab-alert]'); if(b){b.click(); return true;} return false;})()");
  if (!alertTab) problems.push('待我处理缺「异常」页签（B0-5 alert 卡无处呈现）');
  const alertShown = await waitFor(
    "Array.from(document.querySelectorAll('[data-testid=inbox-row]')).some((el) => (el.textContent || '').includes('引擎有事件处理失败'))",
    '引擎异常卡渲染',
    20,
  ).then(() => true, () => false);
  if (!alertShown) problems.push('引擎异常卡未在「异常」页签渲染（B0-5 UI 呈现）');
  // 回到「验收」页签（该卡是 report 类；ask 页签为空，不是默认页签）。
  await evalIn("(function(){var b=document.querySelector('[data-testid=inbox-tab-report]'); if(b) b.click(); return !!b;})()");
  await sleep(200);
  const reportTabShorts = await evalIn(
    "Array.from(document.querySelectorAll('[data-testid=inbox-short]')).map((el) => (el.textContent || '').trim())",
  );
  if (!(reportTabShorts ?? []).includes('T-1002')) {
    problems.push(`验收页签短号=${JSON.stringify(reportTabShorts)}（缺少 T-1002）`);
  }
  await evalIn(`(() => {
    const btn = Array.from(document.querySelectorAll('[data-testid=inbox-short]')).find((el) => (el.textContent || '').trim() === 'T-1002');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await waitFor(
    "document.querySelector('[data-testid=center]')?.dataset.view === 'projects' && document.querySelector('[data-testid=project-task][data-task-id=\"2\"][data-expanded=\"1\"]') !== null",
    '深链落到项目页并展开',
  );
  await waitFor("document.activeElement?.dataset?.taskId === '2'", '深链聚焦目标行', 40);
  const deep = await evalIn(`(() => ({
    view: document.querySelector('[data-testid=center]')?.dataset.view ?? null,
    tab: document.querySelector('[data-testid=project-tab-tasks]')?.getAttribute('aria-selected') ?? null,
    expanded: Array.from(document.querySelectorAll('[data-testid=project-task][data-expanded="1"]')).map((el) => el.dataset.taskId),
    inline: document.querySelectorAll('[data-testid=project-task-inline]').length,
    focusTaskId: document.activeElement?.dataset?.taskId ?? null,
  }))()`);
  console.log('[ui2-project] deep=' + JSON.stringify(deep));
  if (deep?.view !== 'projects') problems.push(`深链视图=${deep?.view}（期望 projects，不跳整页详情）`);
  if (deep?.tab !== 'true') problems.push('深链未切回任务页签');
  if (JSON.stringify(deep?.expanded) !== JSON.stringify(['2'])) problems.push(`深链展开行=${JSON.stringify(deep?.expanded)}`);
  if (deep?.inline !== 1) problems.push(`深链行内详情数=${deep?.inline}`);
  if (deep?.focusTaskId !== '2') problems.push(`深链焦点=${deep?.focusTaskId}（期望目标行 2）`);

  // ⑥ 频道卡深链：老板频道报告卡「去验收」→ 项目页＋目标行展开
  await evalIn("(function(){var b=document.querySelector('[data-testid=leftrail-channel]'); if(b) b.click(); return !!b;})()");
  await waitFor("!!document.querySelector('[data-testid=card-goto-task]')", '频道报告卡出现');
  const permissionCard = await evalIn(`(() => {
    const text = document.body.innerText || '';
    return { title: text.includes('权限请求：bash'), approve: text.includes('批准一次'), egress: text.includes('consent:egress') };
  })()`);
  console.log('[ui2-project] permissionCard=' + JSON.stringify(permissionCard));
  if (!permissionCard?.title || !permissionCard?.approve) {
    problems.push(`权限请求卡未渲染完整（${JSON.stringify(permissionCard)}；B0-9 外发闸门用户面）`);
  }
  await evalIn("(function(){var b=document.querySelector('[data-testid=card-goto-task]'); if(b){b.click(); return true;} return false;})()");
  await waitFor(
    `document.querySelector('[data-testid=center]')?.dataset.view === 'projects' && document.querySelector('[data-testid=project-task][data-task-id="2"][data-expanded="1"]') !== null`,
    '频道卡深链落到项目页并展开',
  );
  const fromCard = await evalIn(`(() => ({
    view: document.querySelector('[data-testid=center]')?.dataset.view ?? null,
    expanded: Array.from(document.querySelectorAll('[data-testid=project-task][data-expanded="1"]')).map((el) => el.dataset.taskId),
  }))()`);
  console.log('[ui2-project] fromCard=' + JSON.stringify(fromCard));
  if (fromCard?.view !== 'projects') problems.push(`频道卡深链视图=${fromCard?.view}（期望 projects）`);
  if (JSON.stringify(fromCard?.expanded) !== JSON.stringify(['2'])) problems.push(`频道卡深链展开=${JSON.stringify(fromCard?.expanded)}`);

  // ⑦ 命令面板深链：Ctrl+K → 输入短号 → 点任务命中 → 项目页＋目标行展开
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 });
  await waitFor("!!document.querySelector('[data-testid=palette-input]')", '命令面板打开');
  await evalIn(`(() => {
    const el = document.querySelector('[data-testid=palette-input]');
    if (!el) return false;
    const setV = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setV.call(el, 'T-1001');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await waitFor(
    "Array.from(document.querySelectorAll('[data-testid=palette-row]')).some((el) => (el.textContent || '').includes('T-1001'))",
    '命令面板任务命中',
  );
  await evalIn(`(() => {
    const row = Array.from(document.querySelectorAll('[data-testid=palette-row]')).find((el) => (el.textContent || '').includes('T-1001'));
    if (!row) return false;
    row.click();
    return true;
  })()`);
  await waitFor(
    `document.querySelector('[data-testid=center]')?.dataset.view === 'projects' && document.querySelector('[data-testid=project-task][data-task-id="1"][data-expanded="1"]') !== null`,
    '命令面板深链落到项目页并展开',
  );
  const fromPalette = await evalIn(`(() => ({
    view: document.querySelector('[data-testid=center]')?.dataset.view ?? null,
    expanded: Array.from(document.querySelectorAll('[data-testid=project-task][data-expanded="1"]')).map((el) => el.dataset.taskId),
  }))()`);
  console.log('[ui2-project] fromPalette=' + JSON.stringify(fromPalette));
  if (fromPalette?.view !== 'projects') problems.push(`命令面板深链视图=${fromPalette?.view}（期望 projects）`);
  if (JSON.stringify(fromPalette?.expanded) !== JSON.stringify(['1'])) problems.push(`命令面板深链展开=${JSON.stringify(fromPalette?.expanded)}`);

  // ⑧ 窄窗 720：SplitLayout 抽屉态＋零横向溢出
  await send('Emulation.setDeviceMetricsOverride', { width: 720, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  const narrow = await evalIn(`(() => {
    const doc = document.documentElement;
    return {
      stacked: !!document.querySelector('[data-testid=split-projects][data-stacked=true]'),
      fab: !!document.querySelector('[data-testid=split-projects-toggle]'),
      overflowX: doc.scrollWidth - doc.clientWidth,
      width: window.innerWidth,
    };
  })()`);
  console.log('[ui2-project] narrow=' + JSON.stringify(narrow));
  if (narrow?.width > 760) problems.push(`窄窗模拟未生效：innerWidth=${narrow?.width}`);
  if (!narrow?.stacked) problems.push('720 窄窗未切到 SplitLayout 抽屉态（data-stacked）');
  if (!narrow?.fab) problems.push('720 窄窗缺列表抽屉开关');
  if (narrow?.overflowX > 1) problems.push(`720 窄窗横向溢出 ${narrow?.overflowX}px`);

  // ⑨ 深色主题：prefers-color-scheme=dark → 背景变深、仍无溢出
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(400);
  const dark = await evalIn(`(() => {
    const bg = getComputedStyle(document.body).backgroundColor;
    const nums = bg.split(',').map((part) => Number(part.replace(/[^0-9.]/g, ''))).slice(0, 3);
    const lum = nums.length === 3 && nums.every((n) => Number.isFinite(n)) ? (nums[0] + nums[1] + nums[2]) / 3 : -1;
    const doc = document.documentElement;
    return { bg, lum, overflowX: doc.scrollWidth - doc.clientWidth };
  })()`);
  console.log('[ui2-project] dark=' + JSON.stringify(dark));
  if (!(dark?.lum >= 0 && dark.lum < 90)) problems.push(`深色主题背景未变深：${JSON.stringify(dark)}`);
  if (dark?.overflowX > 1) problems.push(`深色 720 横向溢出 ${dark?.overflowX}px`);
  await send('Page.enable');
  const darkShot = await send('Page.captureScreenshot', { format: 'png' });
  if (typeof darkShot?.result?.data === 'string' && darkShot.result.data.length > 0) {
    const darkOut = join(EVIDENCE, 'shot-ui2-project-dark-720.png');
    writeFileSync(darkOut, Buffer.from(darkShot.result.data, 'base64'));
    console.log(`[ui2-project] dark screenshot=${darkOut}`);
  }
  await send('Emulation.clearDeviceMetricsOverride');
  await send('Emulation.setEmulatedMedia', { features: [] });

  // ⑥ 真库只读回读：配方没写业务数据
  const check = new Database(dbFile, { readonly: true, fileMustExist: true });
  const states = check.prepare('SELECT id, state FROM tasks ORDER BY id').all();
  const reportState = check.prepare('SELECT state FROM reports WHERE task_id=2 ORDER BY id DESC LIMIT 1').get();
  check.close();
  console.log('[ui2-project] db=' + JSON.stringify({ states, reportState }));
  if (states.length !== 2 || states[0].state !== 'executing' || states[1].state !== 'done') {
    problems.push(`真库任务被改动：${JSON.stringify(states)}`);
  }

  await send('Page.enable');
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const b64 = shot?.result?.data;
  if (typeof b64 === 'string' && b64.length > 0) {
    writeFileSync(OUT, Buffer.from(b64, 'base64'));
    console.log(`[ui2-project] screenshot=${OUT}`);
  } else {
    console.log('[ui2-project] 截图未取到（CDP 无返回图像）——不影响断言结论');
  }

  ws.close();
  if (problems.length > 0) throw new Error('UI-2 S1 真机断言未过：\n  - ' + problems.join('\n  - '));
  console.log(
    '[ui2-project] PASS：行下展开/切换/Esc 回焦/待办深链 全过；真库任务状态未变（' +
      `${states.map((s) => `${s.id}:${s.state}`).join(', ')}）`,
  );
} catch (error) {
  console.error('[ui2-project] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  killTree(pid);
  await sleep(1500);
  console.log(`[ui2-project] killed pid-tree of ${pid}`);
}
