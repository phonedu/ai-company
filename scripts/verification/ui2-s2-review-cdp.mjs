//  S2/ 复核修复真机配方（2026-11-10）：
//   ① 项目页「设置·模型」编辑面——打开表单 → 改默认预算/合并目标分支/策略+默认模型 → 保存 →
//      摘要即时回显（真 DOM）；杀进程后回读真库，确认三列持久化（真库）。
//   ② 归档页「归档项目」区——非空项目删除键禁用、空项目可点；点「恢复」后行消失且库里 archived=0。
// 隔离：临时 userData（AICO_USER_DATA_DIR）＋独立 CDP 端口；不读写真实数据目录；不跑模型。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const REPO = process.cwd();
const require = createRequire(`${REPO}\\package.json`);
const Database = require('better-sqlite3');
const ELECTRON = `${REPO}\\node_modules\\electron\\dist\\electron.exe`;
const EVIDENCE = process.env.AICO_UI_EVIDENCE_DIR?.trim() || 'C:\\Project\\ai-company\\history\\records\\realworld\\ui2-s2-review';
const ud = `${process.env.TEMP}\\aico-ui2-s2-review`;
const root = `${ud}\\project`;
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

const AT = Date.now();
const MIGRATION_MAX = Math.max(
  ...readdirSync(join(REPO, 'src', 'main', 'db', 'migrations'))
    .filter((f) => f.endsWith('.sql'))
    .map((f) => Number(f.split('_')[0]))
    .filter((n) => Number.isFinite(n)),
);
let pid = start();
const findings = { steps: [], shots: [] };
try {
  const dbFile = `${ud}\\aico.sqlite`;
  for (let i = 0; i < 180 && !existsSync(dbFile); i += 1) await sleep(500);
  let migrated = false;
  for (let i = 0; i < 180 && !migrated; i += 1) {
    try {
      const probe = new Database(dbFile, { readonly: true, fileMustExist: true });
      migrated = Number(probe.pragma('user_version', { simple: true })) >= MIGRATION_MAX;
      probe.close();
    } catch {
      /* still migrating */
    }
    if (!migrated) await sleep(500);
  }
  if (!migrated) throw new Error('db not migrated in time');
  await sleep(800);
  killTree(pid);
  await sleep(1200);

  // 种子：项目 1＝活跃（模型编辑目标）；项目 2＝已归档且有 1 个任务（非空→删除键须禁用）；
  //       项目 3＝已归档且空（删除键可用）。
  const db = new Database(dbFile);
  db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('onboarding.completed','true')").run();
  for (const table of ['notifications', 'reports', 'approvals', 'plan_steps', 'task_events', 'work_items', 'tasks']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  db.prepare('DELETE FROM projects').run();
  const insProject = db.prepare(
    'INSERT INTO projects(id, name, root_dir, created_at, archived, archived_at) VALUES(?,?,?,?,?,?)',
  );
  insProject.run(1, '模型编辑样例', root, AT, 0, null);
  insProject.run(2, '归档非空样例', root, AT + 1, 1, AT + 1);
  insProject.run(3, '归档空样例', root, AT + 2, 1, AT + 2);
  const insertTask = db.prepare(
    `INSERT INTO tasks(id, short_id, project_id, title, goal, acceptance, state, priority, risk_level, origin, cost_tokens, archived, created_at, updated_at)
     VALUES(?,?,?,?,?,'[]',?,0,1,'boss',0,?,?,?)`,
  );
  insertTask.run(1, 'T-2001', 1, '模型编辑样例任务', '配方种子', 'executing', 0, AT, AT);
  insertTask.run(2, 'T-2002', 2, '归档项目的历史任务', '配方种子', 'done', 0, AT + 1, AT + 1);
  insertTask.run(3, 'T-2003', 2, '已归档的终态任务', '配方种子', 'done', 1, AT + 2, AT + 2);
  db.close();

  // 连接 CDP（冷启动复验要杀进程再起一次，所以封装成函数；每次新 ws/新 pending）。
  let send;
  let evalIn;
  let waitFor;
  const connect = async () => {
    let page = null;
    for (let i = 0; i < 120 && !page; i += 1) {
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
    send = (method, params = {}) =>
      new Promise((res) => {
        const id = ++seq;
        const t = setTimeout(() => {
          pending.delete(id);
          res({});
        }, 20000);
        pending.set(id, (m) => {
          clearTimeout(t);
          res(m);
        });
        ws.send(JSON.stringify({ id, method, params }));
      });
    evalIn = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r?.result?.exceptionDetails) {
        const d = r.result.exceptionDetails;
        throw new Error(`CDP 注入失败：${d.exception?.description ?? d.text ?? 'Uncaught'}`);
      }
      return r?.result?.result?.value;
    };
    waitFor = async (expression, label, tries = 80) => {
      for (let i = 0; i < tries; i += 1) {
        if ((await evalIn(expression)) === true) return;
        await sleep(250);
      }
      throw new Error(`等待超时：${label}`);
    };
    return ws;
  };
  pid = start();
  await connect();
  // React 受控组件：走原生 setter + input/change 事件（直接改 value 不触发 onChange）。
  const HELPERS = `
    window.__setVal = function (sel, v) {
      var el = document.querySelector(sel);
      if (!el) throw new Error('缺元素 ' + sel);
      var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(v));
      el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
      return true;
    };
    window.__click = function (sel) { var el = document.querySelector(sel); if (!el) throw new Error('缺元素 ' + sel); el.click(); return true; };
    window.__text = function (sel) { return document.querySelector(sel)?.textContent ?? null; };
    true;
  `;
  await waitFor("!!(window.api && document.querySelector('[data-testid=leftrail-projects]'))", '页面就绪');
  await evalIn(HELPERS);
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const data = r?.result?.data;
    if (!data) throw new Error(`截图失败：${name}`);
    const file = join(EVIDENCE, name);
    writeFileSync(file, Buffer.from(data, 'base64'));
    findings.shots.push(file);
  };

  // ── ① 项目页「设置·模型」编辑面 ────────────────────────────────────────────
  await evalIn("window.__click('[data-testid=leftrail-projects]')");
  await waitFor("document.querySelectorAll('[data-testid=project-task]').length >= 1", '项目页任务行');
  await evalIn("window.__click('[data-testid=project-tab-settings]')");
  await waitFor("!!document.querySelector('[data-testid=project-model-card]')", '模型卡');
  await evalIn(HELPERS);
  const before = await evalIn(
    "({summary: window.__text('[data-testid=project-model-summary]'), active: document.querySelector('.project-settings__body')?.dataset.activeGroup ?? null})",
  );
  findings.steps.push({ step: '模型卡初始摘要', value: before });

  await evalIn("window.__click('[data-testid=project-model-edit]')");
  await waitFor("!!document.querySelector('[data-testid=project-model-form]')", '编辑表单');
  await evalIn(HELPERS);
  await shot('ui2-s2-model-form.png');

  // 默认预算
  await evalIn("window.__setVal('[data-testid=project-budget]', '123456')");
  await evalIn("window.__click('[data-testid=project-budget-save]')");
  await waitFor("(window.__text('[data-testid=project-model-notice]')||'').includes('默认任务预算已保存')", '预算保存回执');
  // 合并目标分支
  await evalIn("window.__setVal('[data-testid=project-target-branch]', 'release/x')");
  await evalIn("window.__click('[data-testid=project-target-branch-save]')");
  await waitFor("(window.__text('[data-testid=project-model-notice]')||'').includes('release/x')", '分支保存回执');
  // 策略＋默认模型
  await evalIn("window.__setVal('[data-testid=project-model-policy]', 'fixed')");
  await evalIn("window.__setVal('[data-testid=project-model-default]', 'deepseek/deepseek-v4-pro')");
  await evalIn("window.__click('[data-testid=project-model-save]')");
  await waitFor("(window.__text('[data-testid=project-model-notice]')||'').includes('项目模型策略已保存')", '策略保存回执');
  await waitFor("!document.querySelector('[data-testid=project-model-form]')", '保存后表单单收起');
  const after = await evalIn("window.__text('[data-testid=project-model-summary]')");
  findings.steps.push({ step: '保存后摘要', value: after });
  findings.steps.push({
    step: '摘要字号',
    value: await evalIn("getComputedStyle(document.querySelector('[data-testid=project-model-summary] .project-view__model-summary')).fontSize"),
  });
  await shot('ui2-s2-model-summary.png');

  // ── ② 归档页「归档项目」区 ────────────────────────────────────────────────
  await evalIn("window.__click('[data-testid=leftrail-archive]')");
  await waitFor("document.querySelectorAll('[data-testid=archive-project-row]').length >= 2", '归档项目行');
  await evalIn(HELPERS);
  const arch = await evalIn(`(() => {
    var rows = Array.from(document.querySelectorAll('[data-testid=archive-project-row]'));
    return rows.map(function (r) {
      var del = r.querySelector('[data-testid=archive-project-delete]');
      return { name: (r.querySelector('[data-testid=archive-project-open]')||{}).textContent || null, deleteDisabled: del ? del.disabled : null };
    });
  })()`);
  findings.steps.push({ step: '归档项目行（含删除键状态）', value: arch });
  findings.steps.push({
    step: '归档项目名样式',
    value: await evalIn(`(() => {
      var el = document.querySelector('.tlist__archived-project-row .tlist__linklike');
      var cs = getComputedStyle(el);
      return { fontSize: cs.fontSize, fontWeight: cs.fontWeight, background: cs.backgroundColor };
    })()`),
  });
  await shot('ui2-s2-archive-projects.png');

  // 恢复非空项目（id=2）→ 行应从归档区消失
  await evalIn(`(() => {
    var rows = Array.from(document.querySelectorAll('[data-testid=archive-project-row]'));
    var row = rows.find(function (r) { return (r.querySelector('[data-testid=archive-project-open]')||{}).textContent?.indexOf('归档非空样例') >= 0; });
    if (!row) throw new Error('找不到归档非空样例行');
    row.querySelector('[data-testid=archive-project-restore]').click();
    return true;
  })()`);
  await waitFor("document.querySelectorAll('[data-testid=archive-project-row]').length === 1", '恢复后归档区只剩 1 行');
  findings.steps.push({ step: '恢复后归档项目数', value: await evalIn("document.querySelectorAll('[data-testid=archive-project-row]').length") });

  // ── ③ 失败路径（2026-11-10 验收要求：未验证项全验）：把 userData/exports 做成**文件**，
  // 导出/删除都应在页面上显式报错（不静默）；恢复成目录后再导出应成功并落盘。
  rmSync(join(ud, 'exports'), { recursive: true, force: true });
  writeFileSync(join(ud, 'exports'), 'not a directory', 'utf8');
  await evalIn("window.__click('[data-testid=archive-project-export]')");
  await waitFor("(document.querySelector('[data-testid=archive-project-action-error]')?.textContent||'').includes('导出失败')", '导出失败回执可见', 120);
  await shot('ui2-s2-archive-export-error.png');
  findings.steps.push({
    step: '导出失败回执',
    value: await evalIn("document.querySelector('[data-testid=archive-project-action-error]')?.textContent ?? null"),
  });
  await evalIn("window.__click('[data-testid=archive-project-delete]')");
  await waitFor("!!document.querySelector('[data-testid=archive-project-delete-confirm]')", '删除二次确认');
  await evalIn("window.__click('[data-testid=archive-project-delete-confirm]')");
  await waitFor("(document.querySelector('[data-testid=archive-project-action-error]')?.textContent||'').includes('未删除')", '删除失败回执可见', 120);
  findings.steps.push({
    step: '删除失败回执',
    value: await evalIn("document.querySelector('[data-testid=archive-project-action-error]')?.textContent ?? null"),
  });
  rmSync(join(ud, 'exports'), { force: true });
  await evalIn("window.__click('[data-testid=archive-project-export]')");
  await waitFor("(document.querySelector('[data-testid=archive-project-action-message]')?.textContent||'').includes('已导出项目档案')", '恢复后导出成功', 120);
  findings.steps.push({
    step: '导出成功落盘',
    value: {
      message: await evalIn("document.querySelector('[data-testid=archive-project-action-message]')?.textContent ?? null"),
      files: readdirSync(join(ud, 'exports')).filter((f) => f.endsWith('.json')).length,
    },
  });

  // 冷启动恢复路径（独立复核发现）：上次视图=archive → **进程级重启**（不是 location.reload——
  // 旧 DOM 里已有 archive-project-row，等它会立即返回，第二轮复核实测断言其实发生在 reload 前）。
  // ⚠️ 必须优雅关窗：taskkill /F 会丢 localStorage 的异步落盘（发现：强制杀后重启 cursor=null，
  // 视图回落 channel，冷启动步骤永远等不到归档行）。
  await evalIn(`localStorage.setItem('aico.session.view', JSON.stringify({view:'archive',selectedTaskId:null,selectedProjectId:null,selectedEmployeeId:null})); window.close(); true`);
  await sleep(3000);
  killTree(pid);
  await sleep(1200);
  pid = start();
  await connect();
  await waitFor("!!(window.api && document.querySelector('[data-testid=archive-project-row]'))", '冷启动归档项目行', 160);
  // 进程重启后是新页面上下文：HELPERS（__click/__setVal）必须重新注入。
  await evalIn(HELPERS);
  const cold = await evalIn(`(() => ({
    rows: document.querySelectorAll('[data-testid=archive-project-row]').length,
    tasks: document.querySelectorAll('[data-testid=archive-list] [data-testid=tlist-row]').length,
    view: document.querySelector('[data-testid=center]')?.dataset.view ?? null,
    emptyText: document.querySelector('[data-testid=archive-view]')?.textContent?.includes('暂无归档任务') ?? null,
    restoreNoticeGone: !(document.body.textContent || '').includes('已恢复项目'),
  }))()`);
  findings.steps.push({ step: '冷启动归档页', value: cold });

  // ── ④ 深色 / 窄窗 720 / 非 2x DPI（2026-11-10 验收要求：未验证项全验）
  const lightBg = await evalIn('getComputedStyle(document.body).backgroundColor');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(600);
  const darkBg = await evalIn('getComputedStyle(document.body).backgroundColor');
  await shot('ui2-s2-archive-dark.png');
  findings.steps.push({ step: '深色主题', value: { lightBg, darkBg, changed: lightBg !== darkBg } });

  await evalIn("window.__click('[data-testid=leftrail-projects]')");
  await waitFor("!!document.querySelector('[data-testid=project-tab-settings]')", '项目页(深色)');
  await evalIn("window.__click('[data-testid=project-tab-settings]')");
  await waitFor("!!document.querySelector('[data-testid=project-model-card]')", '模型卡(深色)');
  await shot('ui2-s2-model-dark.png');

  await send('Emulation.setDeviceMetricsOverride', { width: 720, height: 752, deviceScaleFactor: 1, mobile: false });
  await sleep(700);
  // 窄窗下把「设置·模型」也走一遍：单列布局里表单要能开、能滚、主操作可见、零横向溢出。
  await evalIn("window.__click('[data-testid=project-tab-settings]')");
  await waitFor("!!document.querySelector('[data-testid=project-model-card]')", '模型卡(720)');
  await evalIn("window.__click('[data-testid=project-model-edit]')");
  await waitFor("!!document.querySelector('[data-testid=project-model-form]')", '表单(720)');
  await sleep(400);
  const narrow = await evalIn(`(() => {
    const btn = document.querySelector('[data-testid=project-model-save]').getBoundingClientRect();
    return {
      innerW: window.innerWidth,
      scrollW: document.documentElement.scrollWidth,
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      saveVisible: btn.bottom <= window.innerHeight,
    };
  })()`);
  await shot('ui2-s2-model-narrow720.png');
  findings.steps.push({ step: '窄窗720', value: narrow });

  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 752, deviceScaleFactor: 1.25, mobile: false });
  await sleep(700);
  // 视口切换后窄窗抽屉态会重挂中栏：重新走一遍「项目树 → 设置」，别假设上一刻的 DOM 还在。
  await evalIn("window.__click('[data-testid=leftrail-projects]')");
  await waitFor("!!document.querySelector('[data-testid=project-tab-settings]')", '项目页(1280)');
  await evalIn("window.__click('[data-testid=project-tab-settings]')");
  await waitFor("!!document.querySelector('[data-testid=project-model-card]')", '模型卡(1280)');
  if ((await evalIn("!!document.querySelector('[data-testid=project-model-form]')")) !== true) {
    await evalIn("window.__click('[data-testid=project-model-edit]')");
    await waitFor("!!document.querySelector('[data-testid=project-model-form]')", '编辑表单(1.25x)');
  }
  await sleep(500);
  const dpi = await evalIn(`(() => {
    const btn = document.querySelector('[data-testid=project-model-save]').getBoundingClientRect();
    const ctl = document.querySelector('[data-testid=project-model-policy]').getBoundingClientRect();
    return { saveBottom: Math.round(btn.bottom), viewport: window.innerHeight, saveVisible: btn.bottom <= window.innerHeight, controlLeft: Math.round(ctl.left) };
  })()`);
  await shot('ui2-s2-model-dpi125.png');
  findings.steps.push({ step: 'DPI1.25', value: dpi });

  // 1.5 / 1.75 缩放档（验收要求：非 2x DPI 全验；物理显示器 150% 无法在不动系统设置的前提下切，
  // 用 CDP DSF 模拟作代理口径——它决定 CSS px 与设备 px 的映射，是布局溢出的根因）。
  const scaleChecks = [];
  for (const dsf of [1.5, 1.75]) {
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 752, deviceScaleFactor: dsf, mobile: false });
    await sleep(600);
    const c = await evalIn(`(() => ({
      dsf: window.devicePixelRatio,
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      saveVisible: (() => { const b = document.querySelector('[data-testid=project-model-save]'); return b ? b.getBoundingClientRect().bottom <= window.innerHeight : null; })(),
    }))()`);
    scaleChecks.push(c);
    await shot('ui2-s2-model-dsf' + String(dsf).replace('.', '') + '.png');
  }
  findings.steps.push({ step: '缩放1.5/1.75', value: scaleChecks });

  await send('Emulation.clearDeviceMetricsOverride');
  await send('Emulation.setEmulatedMedia', { features: [] });
  await sleep(300);

  // ⑤ 删除空归档项目的**成功**路径（此前只验到按钮可用）：删完行消失、回执给出、真库无该行。
  await evalIn("window.__click('[data-testid=leftrail-archive]')");
  await waitFor("document.querySelectorAll('[data-testid=archive-project-row]').length === 1", '归档页(删除前)');
  await evalIn("window.__click('[data-testid=archive-project-delete]')");
  await waitFor("!!document.querySelector('[data-testid=archive-project-delete-confirm]')", '删除二次确认');
  await evalIn("window.__click('[data-testid=archive-project-delete-confirm]')");
  await waitFor("document.querySelectorAll('[data-testid=archive-project-row]').length === 0", '删除后无归档项目', 160);
  findings.steps.push({
    step: '删除空项目成功',
    value: {
      rowsAfter: await evalIn("document.querySelectorAll('[data-testid=archive-project-row]').length"),
      message: await evalIn("document.querySelector('[data-testid=archive-project-action-message]')?.textContent ?? null"),
    },
  });
  await shot('ui2-s2-archive-coldstart.png');

  findings.ok = true;
} catch (error) {
  findings.ok = false;
  findings.error = error instanceof Error ? `${error.message}\n${error.stack ?? ''}`.slice(0, 1500) : String(error);
} finally {
  try {
    killTree(pid);
  } catch {
    /* ignore */
  }
  await sleep(1200);
  // 真库回读（进程已关）：三列持久化 + 恢复生效。
  try {
    const db = new Database(`${ud}\\aico.sqlite`, { readonly: true, fileMustExist: true });
    const p1 = db.prepare('SELECT default_budget_tokens, target_branch, model_policy, default_model FROM projects WHERE id=1').get();
    const p2 = db.prepare('SELECT archived FROM projects WHERE id=2').get();
    const p3 = db.prepare('SELECT COUNT(*) n FROM projects WHERE id=3').get();
    const pendingTasks = db.prepare("SELECT COUNT(*) n FROM tasks WHERE state IN ('ready','executing')").get();
    findings.db = { project1: p1, project2: p2, project3Gone: p3.n === 0, nonTerminalTasks: pendingTasks.n };
    db.close();
  } catch (error) {
    findings.db = { error: error instanceof Error ? error.message : String(error) };
  }
  const pass =
    findings.ok === true &&
    findings.db?.project1?.default_budget_tokens === 123456 &&
    findings.db?.project1?.target_branch === 'release/x' &&
    findings.db?.project1?.model_policy === 'fixed' &&
    findings.db?.project1?.default_model === 'deepseek/deepseek-v4-pro' &&
    findings.db?.project2?.archived === 0 &&
    findings.db?.project3Gone === true &&
    String(findings.steps.find((s) => s.step === '保存后摘要')?.value ?? '').includes('123456 tokens') &&
    String(findings.steps.find((s) => s.step === '保存后摘要')?.value ?? '').includes('release/x') &&
    String(findings.steps.find((s) => s.step === '保存后摘要')?.value ?? '').includes('deepseek/deepseek-v4-pro') &&
    (findings.steps.find((s) => s.step === '归档项目行（含删除键状态）')?.value ?? []).some((r) => r.name?.includes('归档非空样例') && r.deleteDisabled === true) &&
    (findings.steps.find((s) => s.step === '归档项目行（含删除键状态）')?.value ?? []).some((r) => r.name?.includes('归档空样例') && r.deleteDisabled === false) &&
    findings.steps.find((s) => s.step === '恢复后归档项目数')?.value === 1 &&
    findings.steps.find((s) => s.step === '摘要字号')?.value === '15px' &&
    String(findings.steps.find((s) => s.step === '导出失败回执')?.value ?? '').includes('导出失败') &&
    String(findings.steps.find((s) => s.step === '删除失败回执')?.value ?? '').includes('未删除') &&
    findings.steps.find((s) => s.step === '导出成功落盘')?.value?.files >= 1 &&
    findings.steps.find((s) => s.step === '深色主题')?.value?.changed === true &&
    findings.steps.find((s) => s.step === '窄窗720')?.value?.overflow === false &&
    findings.steps.find((s) => s.step === '窄窗720')?.value?.saveVisible === true &&
    findings.steps.find((s) => s.step === 'DPI1.25')?.value?.saveVisible === true &&
    (findings.steps.find((s) => s.step === '缩放1.5/1.75')?.value ?? []).length === 2 &&
    (findings.steps.find((s) => s.step === '缩放1.5/1.75')?.value ?? []).every((c) => c.overflow === false && c.saveVisible === true) &&
    findings.steps.find((s) => s.step === '删除空项目成功')?.value?.rowsAfter === 0 &&
    String(findings.steps.find((s) => s.step === '删除空项目成功')?.value?.message ?? '').includes('已删除项目') &&
    findings.steps.find((s) => s.step === '归档项目名样式')?.value?.fontSize === '15px' &&
    findings.steps.find((s) => s.step === '归档项目名样式')?.value?.background === 'rgba(0, 0, 0, 0)' &&
    findings.steps.find((s) => s.step === '冷启动归档页')?.value?.restoreNoticeGone === true &&
    findings.steps.find((s) => s.step === '冷启动归档页')?.value?.rows === 1 &&
    (findings.steps.find((s) => s.step === '冷启动归档页')?.value?.tasks ?? 0) >= 1 &&
    findings.steps.find((s) => s.step === '冷启动归档页')?.value?.emptyText === false;
  findings.pass = pass;
  writeFileSync(join(EVIDENCE, `ui2-s2-review-result-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify(findings, null, 2), 'utf8');
  console.log(JSON.stringify({ pass, db: findings.db, steps: findings.steps, shots: findings.shots, error: findings.error ?? null }, null, 2));
  process.exit(pass ? 0 : 1);
}
