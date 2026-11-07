// B1 真跑入口：Electron 主进程解出真实 DeepSeek Key（只放 env），再启动无头评测跑器。
//
// 为什么需要：secrets 已是 safeStorage 密文，纯 Node 无法解密；评测跑器本身不 import Electron。
// 用法：`electron scripts/eval/run-with-key.cjs --limit=1 --tiers=eco`
// 口径：Key 只在子进程 env（不打印、不落盘）；脚本不联网除模型 API 外无副作用。
const { app, safeStorage } = require('electron');
const { spawn } = require('node:child_process');
const { copyFileSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const REPO = join(__dirname, '..', '..');
const PROFILE = join(process.env.APPDATA || '', 'ai-company');
const TMP = mkdtempSync(join(tmpdir(), 'aico-eval-key-'));
copyFileSync(join(PROFILE, 'Local State'), join(TMP, 'Local State'));
app.setPath('userData', TMP);

app.whenReady().then(async () => {
  try {
    const pk = await import(pathToFileURL(join(REPO, 'dist/src/main/agent/provider-keys.js')).href);
    pk.setProviderKeyCodec({
      stable: true,
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
      decrypt: (payload) => safeStorage.decryptString(Buffer.from(payload, 'base64')),
    });
    const cred = pk.resolveProviderKey('deepseek');
    if (!cred) throw new Error('DeepSeek Key 未配置');
    const args = process.argv.slice(2);
    const child = spawn(process.env.ComSpec ? 'node' : 'node', [join(REPO, 'scripts', 'eval', 'run.mjs'), ...args], {
      cwd: REPO,
      stdio: 'inherit',
      env: { ...process.env, DEEPSEEK_API_KEY: cred.key },
    });
    child.on('exit', (code) => {
      try {
        rmSync(TMP, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 });
      } catch {
        /* 进程仍持有 profile 文件 → 交给系统清理 */
      }
      app.exit(code ?? 1);
    });
  } catch (error) {
    console.error('[eval-key] 失败：' + (error && error.message ? error.message : String(error)));
    app.exit(1);
  }
});
