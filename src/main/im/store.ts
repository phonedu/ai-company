/**
 * IM 凭证存储（官方 B 运输）。
 *
 * 只存本机；优先用 Electron `safeStorage`（Windows DPAPI）加密，失败时退回 0600 JSON 并**显式记录**
 * （`encrypted:false`），不假装加密。凭证不进仓库、不进 settings 导出、不写日志。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface WeChatCredentials {
  botToken: string;
  accountId: string;
  baseUrl: string;
  /** 扫码登录者 id；唯一 owner 白名单。 */
  userId: string;
}

export interface ImStoredState {
  credentials: WeChatCredentials | null;
  /** iLink 长轮询游标（重启续传）。 */
  syncBuf: string;
}

export interface ImCredentialStore {
  load(): ImStoredState;
  save(state: ImStoredState): void;
  clear(): void;
}

/** Electron `safeStorage` 的结构子集（避免 core 测试依赖 electron）。 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

interface FileEnvelope {
  version: 1;
  encrypted: boolean;
  data: string;
}

const EMPTY: ImStoredState = { credentials: null, syncBuf: '' };

function emptyState(): ImStoredState {
  return { credentials: null, syncBuf: '' };
}

function isCredentials(value: unknown): value is WeChatCredentials {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.botToken === 'string' &&
    v.botToken.length > 0 &&
    typeof v.accountId === 'string' &&
    typeof v.baseUrl === 'string' &&
    typeof v.userId === 'string' &&
    v.userId.length > 0
  );
}

function parseState(raw: string): ImStoredState {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object') return emptyState();
  const v = parsed as Record<string, unknown>;
  const credentials = isCredentials(v.credentials) ? v.credentials : null;
  const syncBuf = typeof v.syncBuf === 'string' ? v.syncBuf : '';
  return { credentials, syncBuf };
}

export interface FileCredentialStoreOptions {
  /** 缺省 null = 不加密（仅测试/无 keyring 场景）。 */
  safeStorage?: SafeStorageLike | null;
  log?: (message: string, error?: unknown) => void;
}

/**
 * 文件存储：`<userData>/im/wechat.json`。原子写（tmp + rename），0600 尽力而为。
 * safeStorage 可用时整包加密；不可用时写 `encrypted:false` 并告警（不静默）。
 */
export function createFileCredentialStore(
  filePath: string,
  options: FileCredentialStoreOptions = {},
): ImCredentialStore {
  const log = options.log ?? ((message: string, error?: unknown) => console.warn(message, error ?? ''));
  const safeStorage = options.safeStorage ?? null;

  const encrypt = (plain: string): FileEnvelope => {
    if (safeStorage?.isEncryptionAvailable()) {
      return {
        version: 1,
        encrypted: true,
        data: safeStorage.encryptString(plain).toString('base64'),
      };
    }
    log('[im] safeStorage 不可用：IM 凭证将以 0600 明文保存（不假装加密）');
    return { version: 1, encrypted: false, data: plain };
  };

  const decrypt = (envelope: FileEnvelope): string | null => {
    if (!envelope.encrypted) return envelope.data;
    if (!safeStorage?.isEncryptionAvailable()) {
      log('[im] 凭证文件已加密，但 safeStorage 不可用：按未登录处理（需重新扫码）');
      return null;
    }
    try {
      return safeStorage.decryptString(Buffer.from(envelope.data, 'base64'));
    } catch (error) {
      log('[im] 凭证解密失败：按未登录处理（需重新扫码）', error);
      return null;
    }
  };

  return {
    load(): ImStoredState {
      if (!existsSync(filePath)) return emptyState();
      try {
        const envelope = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
        if (!envelope || typeof envelope !== 'object') return emptyState();
        const e = envelope as Record<string, unknown>;
        if (e.version !== 1 || typeof e.encrypted !== 'boolean' || typeof e.data !== 'string') {
          log('[im] 凭证文件格式不认识：按未登录处理（不覆盖原文件）');
          return emptyState();
        }
        const plain = decrypt({ version: 1, encrypted: e.encrypted, data: e.data });
        if (plain == null) return emptyState();
        return parseState(plain);
      } catch (error) {
        log('[im] 凭证文件读取失败：按未登录处理（不覆盖原文件）', error);
        return emptyState();
      }
    },

    save(state: ImStoredState): void {
      mkdirSync(dirname(filePath), { recursive: true });
      const envelope = encrypt(JSON.stringify(state));
      const tmp = `${filePath}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(envelope)}\n`, 'utf8');
      try {
        chmodSync(tmp, 0o600);
      } catch {
        // Windows 上 chmod 基本无效；加密（DPAPI）才是主保护。
      }
      renameSync(tmp, filePath);
    },

    clear(): void {
      try {
        if (existsSync(filePath)) writeFileSync(filePath, `${JSON.stringify({ version: 1, encrypted: false, data: JSON.stringify(EMPTY) })}\n`, 'utf8');
      } catch (error) {
        log('[im] 清空凭证失败（文件保留，下次启动仍会尝试解密）', error);
      }
    },
  };
}

/** 测试/内存实现。 */
export function createMemoryCredentialStore(initial: ImStoredState = EMPTY): ImCredentialStore & {
  peek(): ImStoredState;
} {
  let state: ImStoredState = {
    credentials: initial.credentials ? { ...initial.credentials } : null,
    syncBuf: initial.syncBuf,
  };
  return {
    load: () => ({ credentials: state.credentials ? { ...state.credentials } : null, syncBuf: state.syncBuf }),
    save: (next) => {
      state = { credentials: next.credentials ? { ...next.credentials } : null, syncBuf: next.syncBuf };
    },
    clear: () => {
      state = emptyState();
    },
    peek: () => ({ credentials: state.credentials ? { ...state.credentials } : null, syncBuf: state.syncBuf }),
  };
}
