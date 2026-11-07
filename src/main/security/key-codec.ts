/**
 * B0-9：把 Electron `safeStorage`（Windows DPAPI / macOS Keychain / Linux libsecret）接到
 * 供应商 Key 的落盘编解码器上（`agent/provider-keys.ts` 只依赖接口，不 import Electron）。
 *
 * 口径：只在主进程 ready 后调用一次；`isEncryptionAvailable()=false`（无密钥环）时
 * provider-keys 会**诚实降级**为明文并在状态面显示，不静默丢 Key。
 */
import { safeStorage } from 'electron';

import { setProviderKeyCodec } from '../agent/provider-keys.js';

export function installProviderKeyCodec(): void {
  setProviderKeyCodec({
    available: () => {
      try {
        return safeStorage.isEncryptionAvailable();
      } catch {
        return false;
      }
    },
    encrypt: (plain: string) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (payload: string) => safeStorage.decryptString(Buffer.from(payload, 'base64')),
  });
}
