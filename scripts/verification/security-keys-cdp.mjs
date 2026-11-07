// B0-9 真机配方：供应商 Key 落盘加密（Electron safeStorage/DPAPI）＋重启可回读。
//
// 断言：
//   ① 通过真实 IPC（`provider:set-key`）保存 Key 后，磁盘上**没有明文**，canonical 是 `.enc`（v1: 密文）；
//   ② 旧明文文件不会残留（迁移口径）；
//   ③ 重启同一 HOME 后仍能解析（DPAPI 解密成功），状态只回掩码、不回明文；
//   ④ 清除后文件消失。
// 隔离：HOME/USERPROFILE 指向临时目录（secrets 目录随 homedir），userData 另指临时目录。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const ELECTRON = join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe');
const EVIDENCE = process.env.AICO_UI_EVIDENCE_DIR?.trim() || join(REPO, 'out', 'ui-evidence');
const ud = join(process.env.TEMP ?? '.', 'aico-sec-keys');
const home = join(ud, 'home');
const userData = join(ud, 'userdata');
const port = 9499;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
rmSync(ud, { recursive: true, force: true });
mkdirSync(home, { recursive: true });
mkdirSync(userData, { recursive: true });
mkdirSync(EVIDENCE, { recursive: true });

const PLAIN = 'sk-TESTONLY-realmachine-0001';
const secrets = join(home, '.aico', 'secrets');
const encPath = join(secrets, 'deepseek_api_key.enc');
const plainPath = join(secrets, 'deepseek_api_key');

const start = () =>
  spawn(ELECTRON, ['.', `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`], {
    cwd: REPO,
    stdio: 'ignore',
    env: {
      ...process.env,
      // secrets 目录＝os.homedir()/.aico/secrets；把 homedir 圈进临时目录（不碰真实 Key）。
      USERPROFILE: home,
      HOME: home,
      AICO_USER_DATA_DIR: userData,
      // 配方显式声明：本 profile 由配方自持（不删）——允许加密；生产隔离 profile 默认禁用加密。
      AICO_ALLOW_EPHEMERAL_ENCRYPTION: '1',
    },
  }).pid;
const killTree = (pid) => spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });

let pid = start();
let ws = null;
try {
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
  ws = new WebSocket(page.webSocketDebuggerUrl);
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
  for (let i = 0; i < 90; i += 1) {
    if (await evalIn("!!(window.api && window.api.provider && document.querySelector('[data-testid=leftrail-projects]'))")) break;
    await sleep(500);
  }

  const problems = [];
  // ① 真 IPC 保存
  const saved = await evalIn(`(async () => {
    const r = await window.api.provider.setKey({ provider: 'deepseek', key: ${JSON.stringify(PLAIN)} });
    const list = await window.api.provider.list();
    const rows = Array.isArray(list?.providers) ? list.providers : Array.isArray(list) ? list : [];
    const row = rows.find((p) => p.provider === 'deepseek') ?? null;
    return { ok: r?.ok ?? null, masked: row?.masked ?? null, configured: row?.configured ?? null };
  })()`);
  console.log('[security-keys] saved=' + JSON.stringify(saved));
  if (saved?.ok !== true) problems.push(`保存失败：${JSON.stringify(saved)}`);
  if (saved?.configured !== true) problems.push('保存后状态未显示已配置');
  if (saved?.masked !== '••••0001') problems.push(`掩码=${saved?.masked}（期望 ••••0001）`);

  // ② 落盘不是明文
  if (!existsSync(encPath)) problems.push('缺 .enc 密文文件（safeStorage 未接线或降级为明文）');
  if (existsSync(plainPath)) problems.push('仍有明文 canonical 文件（迁移未生效）');
  if (existsSync(encPath)) {
    const raw = readFileSync(encPath, 'utf8');
    if (raw.includes(PLAIN)) problems.push('密文文件里出现明文 Key');
    if (!raw.startsWith('v1:')) problems.push('密文缺 v1: 版本前缀');
    console.log(`[security-keys] enc bytes=${raw.length} prefix=${raw.slice(0, 3)}`);
  }

  // ③ 重启后仍可解（同一 HOME）
  // 注意：OSCrypt 的密钥材料在 Chromium Local State 里**异步落盘**；保存后立刻 taskkill /F
  // 会丢掉密钥（表现为密文不可解）。真机口径用优雅退出（Browser.close）＝用户正常关应用。
  ws.close();
  ws = null;
  try {
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
  } catch (error) {
    console.log('[security-keys] 优雅关闭失败（将强制回收）：' + (error instanceof Error ? error.message : String(error)));
  }
  killTree(pid); // 兜底：已退出则无害
  await sleep(1000);
  pid = start();
  page = null;
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
  if (!page) throw new Error('no page target after restart');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('CDP ws 重连超时（15s）')), 15000);
    ws.onopen = () => {
      clearTimeout(t);
      res();
    };
    ws.onerror = (e) => {
      clearTimeout(t);
      rej(e);
    };
  });
  seq = 0;
  pending.clear();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const cb = pending.get(m.id);
    if (cb) {
      pending.delete(m.id);
      cb(m);
    }
  };
  for (let i = 0; i < 90; i += 1) {
    if (await evalIn("!!(window.api && window.api.provider && document.querySelector('[data-testid=leftrail-projects]'))")) break;
    await sleep(500);
  }
  const afterRestart = await evalIn(`(async () => {
    const list = await window.api.provider.list();
    const rows = Array.isArray(list?.providers) ? list.providers : Array.isArray(list) ? list : [];
    const row = rows.find((p) => p.provider === 'deepseek') ?? null;
    return { configured: row?.configured ?? null, masked: row?.masked ?? null };
  })()`);
  console.log('[security-keys] afterRestart=' + JSON.stringify(afterRestart));
  if (afterRestart?.configured !== true) problems.push('重启后无法回读 Key（DPAPI 解密失败或文件丢失）');
  if (afterRestart?.masked !== '••••0001') problems.push(`重启后掩码=${afterRestart?.masked}`);

  // ④ 清除
  const cleared = await evalIn(`(async () => {
    const r = await window.api.provider.clearKey({ provider: 'deepseek' });
    return { ok: r?.ok ?? null };
  })()`);
  if (cleared?.ok !== true) problems.push('清除失败');
  await sleep(200);
  if (existsSync(encPath)) problems.push('清除后密文文件仍在');

  if (problems.length > 0) throw new Error('B0-9 Key 加密真机断言未过：\n  - ' + problems.join('\n  - '));
  console.log('[security-keys] PASS：真 IPC 保存 → 落盘 v1 密文（无明文）→ 重启可读掩码 → 清除即删');
} catch (error) {
  console.error('[security-keys] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  killTree(pid);
  await sleep(1200);
  console.log(`[security-keys] killed pid-tree of ${pid}`);
}
