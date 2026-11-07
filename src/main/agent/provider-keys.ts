/**
 * 供应商 API Key 的**本机凭据面**（设置页「模型与供应商」写入）。
 *
 * 口径（EMPLOYEES §10 / `pi-runtime` 既有解析顺序）：
 *  - 落盘：装了系统密钥环（Electron `safeStorage`＝Windows DPAPI / macOS Keychain）时写
 *    `<provider>_api_key.enc`（`v1:` + 密文 base64）；编码器不可用才回落明文文件（诚实降级）。
 *    旧明文文件在首次读取时**迁移**为密文并删除（B0-9，对照 IM 凭据口径）。
 *  - 读取顺序：`env <PROVIDER>_API_KEY` →  canonical 密文 → 旧明文文件名（`<provider>-api-key.txt`
 *    / `<provider>_api_key.txt` / `<provider>_api_key`）。
 *  - 对外只回「是否配置 / 来源 / 尾号掩码」；**绝不回明文**。
 *  - 环境变量存在时优先生效；界面保存的文件不会覆盖它（状态里同时给出 env/file 两面）。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const PROVIDERS = [
  { id: 'deepseek', label: 'DeepSeek', envVar: 'DEEPSEEK_API_KEY' },
  { id: 'xiaomi', label: 'Xiaomi MiMo', envVar: 'XIAOMI_API_KEY' },
  { id: 'anthropic', label: 'Anthropic', envVar: 'ANTHROPIC_API_KEY' },
  { id: 'openai', label: 'OpenAI', envVar: 'OPENAI_API_KEY' },
] as const;

/** 本机加密编解码器（Electron safeStorage 注入；测试可注入 fake）。 */
export interface SecretCodec {
  available(): boolean;
  /** 返回 base64 密文（不带前缀）。 */
  encrypt(plain: string): string;
  /** 解 base64 密文；失败抛错。 */
  decrypt(payload: string): string;
}

let keyCodec: SecretCodec | null = null;
/** 主进程启动时注入（`security/key-codec.ts`）；传 null＝卸载（测试）。 */
export function setProviderKeyCodec(codec: SecretCodec | null): void {
  keyCodec = codec;
}
/** 当前编解码器是否可用（状态面/测试用）。 */
export function providerKeyCodecAvailable(): boolean {
  try {
    return keyCodec?.available() === true;
  } catch {
    return false;
  }
}

export type ProviderId = (typeof PROVIDERS)[number]['id'];

export interface ProviderStatus {
  /** 内置 4 家或任意合法自定义 provider id（`[a-z0-9_-]`，≤32）。 */
  provider: string;
  label: string;
  configured: boolean;
  source: 'env' | 'file' | null;
  /** 尾号掩码；未配置 = null。 */
  masked: string | null;
  /** 环境变量是否配置（优先于文件）。 */
  envConfigured: boolean;
  /** 本机 secrets 文件是否配置。 */
  fileConfigured: boolean;
}

export interface ProviderCredential {
  provider: string;
  key: string;
  source: 'env' | 'file';
  path?: string;
}

export interface ProviderKeyOptions {
  /** 测试注入；缺省 `~/.aico/secrets`。 */
  baseDir?: string;
  /** 测试注入；缺省 `process.env`。 */
  env?: NodeJS.ProcessEnv;
}

export class ProviderKeyError extends Error {
  constructor(
    public readonly code: 'bad_provider' | 'bad_key' | 'write_failed',
    message: string,
  ) {
    super(message);
    this.name = 'ProviderKeyError';
  }
}

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDERS as readonly { id: string }[]).some((p) => p.id === value);
}

export function defaultSecretsDir(): string {
  return join(homedir(), '.aico', 'secrets');
}

function secretsDir(options: ProviderKeyOptions): string {
  return options.baseDir ?? defaultSecretsDir();
}

function envKeyFor(provider: string, env: NodeJS.ProcessEnv): string | null {
  const value = env[`${provider.toUpperCase()}_API_KEY`]?.trim();
  return value && value.length > 0 ? value : null;
}

function mask(key: string): string {
  if (key.length <= 4) return '••••';
  return `••••${key.slice(-4)}`;
}

/** 解析与清除共用的候选文件名；顺序＝优先级（canonical 永远优先）。 */
function keyFileNames(provider: string): string[] {
  return [`${provider}_api_key`, `${provider}-api-key.txt`, `${provider}_api_key.txt`];
}

/**
 * 解析凭据（运行时与设置页共用；**只读**，调用方不得打印 key）。
 * provider 允许任意 `[a-z0-9_-]`（运行时可能用 local 等）；设置页只列目录内的供应商。
 */
export function resolveProviderKey(provider: string, options: ProviderKeyOptions = {}): ProviderCredential | null {
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(provider)) return null;
  const env = options.env ?? process.env;
  const fromEnv = envKeyFor(provider, env);
  if (fromEnv) return { provider, key: fromEnv, source: 'env' };
  const base = secretsDir(options);
  // ① canonical 密文（B0-9）：安全存储可用才解得开；不可用则降级看旧明文（诚实，不假装已加密）。
  const enc = join(base, `${provider}_api_key.enc`);
  if (existsSync(enc)) {
    const raw = readFileSync(enc, 'utf8').trim();
    if (raw.startsWith('v1:') && keyCodec && providerKeyCodecAvailable()) {
      try {
        const key = keyCodec.decrypt(raw.slice(3)).trim();
        if (key.length > 0) return { provider, key, source: 'file', path: enc };
      } catch (error) {
        console.error(
          `[keys] 密文解密失败（系统密钥环变更/损坏）；回退旧文件：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else if (raw.startsWith('v1:')) {
      console.error('[keys] 密文存在但系统密钥环不可用——跳过密文（回退旧明文，如存在）');
    }
  }
  // ② 旧明文（首读即迁移：写密文、删明文；迁移失败不丢凭据）。
  for (const name of keyFileNames(provider)) {
    const path = join(base, name);
    if (!existsSync(path)) continue;
    const key = readFileSync(path, 'utf8').trim();
    if (key.length === 0) continue;
    if (keyCodec && providerKeyCodecAvailable()) {
      try {
        writeFileSync(enc, `v1:${keyCodec.encrypt(key)}\n`, { mode: 0o600 });
        rmSync(path, { force: true });
        return { provider, key, source: 'file', path: enc };
      } catch (error) {
        console.error(
          `[keys] 旧明文迁移失败（继续明文读取，不丢凭据）：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return { provider, key, source: 'file', path };
  }
  return null;
}

function statusFor(provider: string, options: ProviderKeyOptions): ProviderStatus {
  const env = options.env ?? process.env;
  const envConfigured = envKeyFor(provider, env) !== null;
  const cred = resolveProviderKey(provider, options);
  // 文件是否存在独立于 env 优先级：env 命中时仍要知道本机文件在不在（UI 才能给「清除」）。
  const fileCred = resolveProviderKey(provider, { ...options, env: {} });
  return {
    provider,
    label: PROVIDERS.find((p) => p.id === provider)?.label ?? provider,
    configured: cred !== null,
    source: cred?.source ?? null,
    masked: cred ? mask(cred.key) : null,
    envConfigured,
    fileConfigured: fileCred?.source === 'file',
  };
}

export function providerStatuses(options: ProviderKeyOptions = {}): ProviderStatus[] {
  return PROVIDERS.map((p) => statusFor(p.id, options));
}

/** 供应商 id 安全字符集（与 `resolveProviderKey` 同口径；内置 4 家只是目录，不是唯一可配范围）。 */
function isKeyProviderId(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(value);
}

/** 保存到 canonical 文件（0600）；校验失败抛 `ProviderKeyError`，不静默。 */
export function saveProviderKey(provider: string, key: string, options: ProviderKeyOptions = {}): ProviderStatus {
  if (!isKeyProviderId(provider)) {
    throw new ProviderKeyError(
      'bad_provider',
      `供应商 id 需为小写字母/数字/_/-（≤32 字符；内置：${PROVIDERS.map((p) => p.id).join('/')}）`,
    );
  }
  const value = typeof key === 'string' ? key.trim() : '';
  if (value.length < 8 || value.length > 4096) {
    throw new ProviderKeyError('bad_key', 'Key 长度需在 8–4096 字符之间');
  }
  if (/\s/.test(value)) {
    throw new ProviderKeyError('bad_key', 'Key 不能包含空格或换行');
  }
  const base = secretsDir(options);
  try {
    mkdirSync(base, { recursive: true, mode: 0o700 });
    try {
      chmodSync(base, 0o700);
    } catch {
      /* Windows 上 chmod 可能无效；不阻断保存 */
    }
    const encPath = join(base, `${provider}_api_key.enc`);
    if (keyCodec && providerKeyCodecAvailable()) {
      writeFileSync(encPath, `v1:${keyCodec.encrypt(value)}\n`, { mode: 0o600 });
      try {
        chmodSync(encPath, 0o600);
      } catch {
        /* Windows chmod 无效；实际保护来自 DPAPI/Keychain */
      }
      // 迁移：旧明文（含兼容文件名）立即删除。
      for (const name of keyFileNames(provider)) rmSync(join(base, name), { force: true });
    } else {
      // 诚实降级：无系统密钥环时只能明文（设置页状态会如实显示）。
      console.error('[keys] 系统密钥环不可用 → Key 以明文保存（降级；建议开启系统凭据保护）');
      const plainPath = join(base, `${provider}_api_key`);
      writeFileSync(plainPath, `${value}\n`, { mode: 0o600 });
      try {
        chmodSync(plainPath, 0o600);
      } catch {
        /* 同上 */
      }
      rmSync(encPath, { force: true });
    }
  } catch (error) {
    throw new ProviderKeyError('write_failed', `写入本机凭据失败：${error instanceof Error ? error.message : String(error)}`);
  }
  return statusFor(provider, options);
}

/** 清除本机文件（canonical ＋ 兼容文件名）。环境变量无法从界面清除，状态会如实显示仍由 env 提供。 */
export function clearProviderKey(provider: string, options: ProviderKeyOptions = {}): ProviderStatus {
  if (!isKeyProviderId(provider)) {
    throw new ProviderKeyError('bad_provider', `供应商 id 需为小写字母/数字/_/-（≤32 字符）：${provider}`);
  }
  const base = secretsDir(options);
  rmSync(join(base, `${provider}_api_key.enc`), { force: true });
  for (const name of keyFileNames(provider)) {
    const path = join(base, name);
    try {
      rmSync(path, { force: true });
    } catch (error) {
      throw new ProviderKeyError('write_failed', `清除本机凭据失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return statusFor(provider, options);
}
