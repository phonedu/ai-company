//  真机配方：更新「人工确认」链路（发现新版 → 点「下载更新」→ 下载完成 → 出现「重启安装」）。
//
// 用假更新器（AICO_UPDATE_FAKE=1，仅开发版启用）验证真实 UI ＋ preload ＋ IPC ＋ 控制器：
//   - 检查更新前没有「下载更新」按钮（不自动下载）；
//   - 检查→发现新版本→出现「下载更新」；
//   - 点下载→downloading→downloaded→出现「重启安装」；
// 不联网、不真下载/安装。打包版的真更新下载仍需发新版本时实测（记录为未验证）。
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const ELECTRON = join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe');
const EVIDENCE = process.env.AICO_UI_EVIDENCE_DIR?.trim() || join(REPO, 'out', 'ui-evidence');
const ud = join(process.env.TEMP ?? '.', 'aico-update-ui');
const port = 9493;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
spawnSync('cmd', ['/c', 'rmdir', '/S', '/Q', ud], { stdio: 'ignore' });
mkdirSync(EVIDENCE, { recursive: true });
mkdirSync(ud, { recursive: true });

const child = spawn(
  ELECTRON,
  ['.', `--user-data-dir=${ud}`, `--remote-debugging-port=${port}`],
  {
    cwd: REPO,
    stdio: 'ignore',
    env: { ...process.env, AICO_USER_DATA_DIR: ud, AICO_UPDATE_FAKE: '1' },
  },
);

let ws = null;
try {
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
  if (!page) throw new Error('页面未就绪');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('CDP ws 超时')), 15000);
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
    pending.get(m.id)?.(m);
    pending.delete(m.id);
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
    if (r?.result?.exceptionDetails) throw new Error(`CDP 注入失败：${r.result.exceptionDetails.text ?? 'Uncaught'}`);
    return r?.result?.result?.value;
  };
  const waitFor = async (expression, label, tries = 60) => {
    for (let i = 0; i < tries; i += 1) {
      if ((await evalIn(expression)) === true) return true;
      await sleep(250);
    }
    throw new Error(`等待超时：${label}`);
  };
  await waitFor("!!(window.api && document.querySelector('[data-testid=leftrail-settings]'))", '页面就绪');

  const problems = [];
  // 进入设置 → 数据与关于
  await evalIn("(function(){var b=document.querySelector('[data-testid=leftrail-settings]'); if(b) b.click(); return !!b;})()");
  await waitFor("!!document.querySelector('[data-testid=settings-group-data]')", '设置导航');
  await evalIn("(function(){var b=document.querySelector('[data-testid=settings-group-data]'); if(b) b.click(); return !!b;})()");
  await waitFor("!!document.querySelector('[data-testid=settings-update-check]')", '自动更新行');
  const before = await evalIn(`(() => ({
    status: document.querySelector('[data-testid=settings-update-status]')?.textContent ?? null,
    download: !!document.querySelector('[data-testid=settings-update-download]'),
    install: !!document.querySelector('[data-testid=settings-update-install]'),
  }))()`);
  console.log('[update-ui] before=' + JSON.stringify(before));
  if (before?.download) problems.push('检查更新前就出现「下载更新」按钮（疑似自动流程）');

  await evalIn("(function(){var b=document.querySelector('[data-testid=settings-update-check]'); if(b){b.click(); return true;} return false;})()");
  await waitFor("!!document.querySelector('[data-testid=settings-update-download]')", '发现新版本后出现「下载更新」');
  const available = await evalIn(`(() => ({
    status: document.querySelector('[data-testid=settings-update-status]')?.textContent ?? null,
    install: !!document.querySelector('[data-testid=settings-update-install]'),
  }))()`);
  console.log('[update-ui] available=' + JSON.stringify(available));
  if (available?.install) problems.push('未下载就出现「重启安装」（跳过人工确认）');
  if (!String(available?.status ?? '').includes('9.9.9')) problems.push(`状态未显示新版本号：${available?.status}`);

  await evalIn("(function(){var b=document.querySelector('[data-testid=settings-update-download]'); if(b){b.click(); return true;} return false;})()");
  await waitFor("!!document.querySelector('[data-testid=settings-update-install]')", '下载完成后出现「重启安装」');
  const done = await evalIn(`(() => ({
    status: document.querySelector('[data-testid=settings-update-status]')?.textContent ?? null,
    install: !!document.querySelector('[data-testid=settings-update-install]'),
  }))()`);
  console.log('[update-ui] downloaded=' + JSON.stringify(done));
  if (done?.install !== true) problems.push('下载完成没有「重启安装」入口');
  if (!/已下载/.test(String(done?.status ?? ''))) problems.push(`下载完成状态文案不对：${done?.status}`);

  await send('Page.enable');
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (typeof shot?.result?.data === 'string' && shot.result.data.length > 0) {
    const out = join(EVIDENCE, 'shot-update-download-ui.png');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
    console.log(`[update-ui] screenshot=${out}`);
  }

  if (problems.length > 0) throw new Error('B0-9 更新人工确认真机断言未过：\n  - ' + problems.join('\n  - '));
  console.log('[update-ui] PASS：不自动下载 → 检查后有「下载更新」→ 点下载完成 → 才出现「重启安装」');
} catch (error) {
  console.error('[update-ui] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  await sleep(1000);
  spawnSync('cmd', ['/c', 'rmdir', '/S', '/Q', ud], { stdio: 'ignore' });
  console.log(`[update-ui] killed pid-tree of ${child.pid}`);
}
