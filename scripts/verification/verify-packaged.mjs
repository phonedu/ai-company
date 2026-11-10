// 打包产物验证（2026-11-10）：跑 dist/win-unpacked/AICompany.exe（临时 userData），
// 连主进程 V8 inspector，证明「随包 ffmpeg 已进 PATH 且能被解析执行」。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

const REPO = process.cwd();
const EXE = `${REPO}/dist/win-unpacked/AICompany.exe`;
const TMP = String(process.env.TEMP || '').replace(/\\/g, '/');
const ud = `${TMP}/aico-packaged-check`;
const root = `${ud}/project`;
const inspectPort = 9229;
const cdpPort = 9501;
rmSync(ud, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pid = spawn(EXE, [`--user-data-dir=${ud}`, `--remote-debugging-port=${cdpPort}`, `--inspect=${inspectPort}`], {
  cwd: REPO,
  stdio: 'ignore',
  env: { ...process.env, AICO_USER_DATA_DIR: ud, AICO_DEFAULT_PROJECT_ROOT: root },
}).pid;
const kill = (p) => spawnSync('taskkill', ['/PID', String(p), '/T', '/F'], { stdio: 'ignore' });

const result = { exeExists: existsSync(EXE), ok: false };
try {
  // 等主进程 inspector 就绪
  let target = null;
  for (let i = 0; i < 120 && !target; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json();
      target = (list || []).find((t) => t.webSocketDebuggerUrl) ?? null;
    } catch {
      /* not ready */
    }
    if (!target) await sleep(500);
  }
  if (!target) throw new Error('main inspector not ready');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
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
      const t = setTimeout(() => res({}), 10000);
      pending.set(id, (m) => {
        clearTimeout(t);
        res(m);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evalMain = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true });
    if (r?.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
    return r?.result?.result?.value;
  };
  // 给 main 一点时间跑完启动（PATH 前置发生在 ready 早期）
  await sleep(2500);
  result.resourcesPath = await evalMain('process.resourcesPath');
  result.pathHasPackagedFfmpeg = await evalMain(
    "process.env.PATH.split(';').some((p) => p.replace(/\\\\/g, '/').toLowerCase().includes('/resources/ffmpeg'))",
  );
  result.whichFfmpeg = await evalMain(
    "(() => { try { const { execFileSync } = require('node:child_process'); return execFileSync('ffmpeg', ['-version'], { encoding: 'utf8', timeout: 8000 }).split('\\n')[0]; } catch (e) { return 'ERR: ' + e.message; } })()",
  );
  result.ffmpegDirInPath = await evalMain(
    "process.env.PATH.split(';').filter((p) => /resources[\\\\/]ffmpeg/i.test(p))",
  );
  result.version = await evalMain('process.versions.electron');
  result.ok =
    Array.isArray(result.ffmpegDirInPath) &&
    result.ffmpegDirInPath.some((p) => /win-unpacked\/resources\/ffmpeg$/i.test(String(p).replace(/\\/g, '/'))) &&
    String(result.whichFfmpeg).trim().startsWith('ffmpeg version');
} catch (error) {
  result.error = error instanceof Error ? `${error.message}\n${error.stack ?? ''}`.slice(0, 1200) : String(error);
} finally {
  kill(pid);
  await sleep(800);
  writeFileSync(`${TMP}/aico-packaged-check-result.json`, JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
