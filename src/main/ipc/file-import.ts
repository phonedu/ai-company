import type { IpcMain } from 'electron';
import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createReadStream } from 'node:fs';

import { stagedFileName } from './staged-files.js';

// ─────────────────────────────────────────────────────────────────────────────
// 文件导入 IPC（DEV §7.3 D1 例外③ / T0.5 起）。
//
//   `file:import`        —— 入参是 **preload** 通过 `webUtils.getPathForFile(File)` 得到的可信路径；
//                           主进程按该路径流式复制到 staging 目录，返回不透明 `fileToken`。
//   `file:import-bytes`  —— 无盘路径来源（如剪贴板截图）：入参是 `arrayBuffer()` 的字节；
//                           主进程写盘后同样返回 `fileToken`。
//
//   铁律（D1）：**返回体只有 `fileToken + 元信息`，绝不回传路径**；staging 文件名由 token 生成，
//   不信任原始文件名（防路径穿越）。
// ─────────────────────────────────────────────────────────────────────────────

const SINGLE_FILE_MAX_BYTES = 100 * 1024 * 1024; // UI §4.5/§4.6

function stagedDir(): string {
  const dir = join(app.getPath('userData'), 'staged-inputs');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function ok(file: { fileToken: string; name: string; size: number; type: string }): unknown {
  return { ok: true, file };
}

function bad(code: string, message: string): unknown {
  return { ok: false, code, message };
}

export function registerFileImportIpc(ipcMain: IpcMain): void {
  // ── 可信路径通路（preload webUtils）────────────────────────────────────
  ipcMain.handle('file:import', async (_event, raw) => {
    const input = (raw ?? {}) as { path?: unknown; name?: unknown; type?: unknown };
    const path = typeof input.path === 'string' ? input.path : '';
    const name = typeof input.name === 'string' ? input.name : '';
    const type = typeof input.type === 'string' ? input.type : 'application/octet-stream';
    if (path.length === 0 || name.length === 0) {
      return bad('bad_request', 'path + name are required');
    }
    let size: number;
    try {
      const stat = statSync(path);
      if (!stat.isFile()) return bad('not_a_file', 'path is not a regular file');
      size = stat.size;
    } catch {
      return bad('not_found', 'source file is not readable');
    }
    if (size > SINGLE_FILE_MAX_BYTES) return bad('too_large', 'file exceeds 100MB');

    const fileToken = randomUUID();
    const dest = join(stagedDir(), stagedFileName(fileToken, name));
    try {
      // 流式复制：不把整块读进主进程内存。
      await pipeline(createReadStream(path), createWriteStream(dest));
    } catch (error) {
      return bad('io_error', error instanceof Error ? error.message : String(error));
    }
    return ok({ fileToken, name, size: Math.min(size, SINGLE_FILE_MAX_BYTES), type });
  });

  // ── 字节通路（剪贴板截图等无盘路径来源）──────────────────────────────
  ipcMain.handle('file:import-bytes', async (_event, raw) => {
    const input = (raw ?? {}) as { name?: unknown; type?: unknown; bytes?: unknown };
    const name = typeof input.name === 'string' ? input.name : '';
    const type = typeof input.type === 'string' ? input.type : 'application/octet-stream';
    if (name.length === 0) return bad('bad_request', 'name is required');
    const bytes = toBuffer(input.bytes);
    if (!bytes) return bad('bad_request', 'bytes is required');
    if (bytes.byteLength > SINGLE_FILE_MAX_BYTES) return bad('too_large', 'file exceeds 100MB');

    const fileToken = randomUUID();
    const dest = join(stagedDir(), stagedFileName(fileToken, name));
    try {
      await writeFile(dest, bytes);
    } catch (error) {
      return bad('io_error', error instanceof Error ? error.message : String(error));
    }
    return ok({ fileToken, name, size: bytes.byteLength, type });
  });
}

/** IPC 传过来的 `ArrayBuffer` / `Uint8Array` → Buffer。 */
function toBuffer(value: unknown): Buffer | null {
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}
