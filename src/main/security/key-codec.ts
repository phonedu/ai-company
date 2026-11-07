/**
 * B0-9：把 Electron `safeStorage`（Windows DPAPI / macOS Keychain / Linux libsecret）接到
 * 供应商 Key 的落盘编解码器上（`agent/provider-keys.ts` 只依赖接口，不 import Electron）。
 *
 * 口径：只在主进程 ready 后调用一次；`isEncryptionAvailable()=false`（无密钥环）时
 * provider-keys 会**诚实降级**为明文并在状态面显示，不静默丢 Key。
 *
 * `stable:false`（`AICO_USER_DATA_DIR` 隔离/临时 profile）：OSCrypt 密钥材料随 profile 消失，
 * 密文会永久不可解（2026-11-07 事故）——此时禁用加密，只写明文。
 */
import { safeStorage } from 'electron';

import { setProviderKeyCodec } from '../agent/provider-keys.js';

export function installProviderKeyCodec(options: { stable: boolean } = { stable: true }): void {
  setProviderKeyCodec({
    stable: options.stable,
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
