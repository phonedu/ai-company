/**
 * `chat:resolve-attachment` —— 按 `{messageId, index}` 反查消息附件并生成**安全预览**。
 *
 * 口径（/ UI §4.6 / §8）：
 *  - renderer 只传消息 id + 下标；**不传路径**；
 *  - 主进程查 `human_messages.attachments[index]` 的 `fileToken`，再按 staging 规则找文件；
 *  - 图片/PDF 返回 `aico-file://preview/<短票>`（协议处理器只认自己签出的短票）；
 *  - 文本返回前缀（截断如实标注）；其他类型只回元信息（不假装能预览）。
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { extname } from 'node:path';

import { getHumanMessage } from '../db/human_messages.js';
import type { SqliteDb } from '../db/open.js';
import { createPreviewToken } from './attachment-preview.js';
import { stagedFilePath } from './staged-files.js';

const MAX_PREVIEW_BYTES = 50 * 1024 * 1024;
const MAX_TEXT_BYTES = 200 * 1024;

export type AttachmentPreviewKind = 'image' | 'pdf' | 'text' | 'file';

export interface AttachmentPreviewDTO {
  kind: AttachmentPreviewKind;
  name: string;
  size: number;
  type: string;
  previewable: boolean;
  /** 图片/PDF：受控协议 URL；文本不走 URL。 */
  url?: string;
  /** 文本前缀（最多 200KB）。 */
  text?: string;
  truncated?: boolean;
}

export type AttachmentPreviewResult =
  | { ok: true; attachment: AttachmentPreviewDTO }
  | { ok: false; code: 'bad_request' | 'not_found' | 'preview_unavailable' | 'preview_failed'; message: string };

export interface AttachmentResolveDeps {
  db?: SqliteDb;
  stagedFilesDir?: () => string;
}

interface AttachmentMetaLike {
  name?: unknown;
  size?: unknown;
  type?: unknown;
  fileToken?: unknown;
}

function bad(code: Extract<AttachmentPreviewResult, { ok: false }>['code'], message: string): AttachmentPreviewResult {
  return { ok: false, code, message };
}

export function inferType(name: string, rawType: unknown): string {
  const provided = typeof rawType === 'string' ? rawType.trim() : '';
  if (provided.length > 0) return provided;
  const ext = extname(name).toLowerCase();
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.log': 'text/plain',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.xml': 'application/xml',
    '.yml': 'text/yaml',
    '.yaml': 'text/yaml',
  };
  return map[ext] ?? 'application/octet-stream';
}

export function kindFor(name: string, type: string): AttachmentPreviewKind {
  const ext = extname(name).toLowerCase();
  const lower = type.toLowerCase();
  // SVG 可带脚本，不在 v1 预览白名单里（按普通文件处理）。
  const imageExt = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'];
  if (lower.startsWith('image/') && lower !== 'image/svg+xml') return 'image';
  if (imageExt.includes(ext)) return 'image';
  if (lower === 'application/pdf' || ext === '.pdf') return 'pdf';
  const textExt = ['.md', '.txt', '.log', '.csv', '.json', '.xml', '.yml', '.yaml'];
  if (lower.startsWith('text/') || lower === 'application/json' || lower.endsWith('+xml') || textExt.includes(ext)) {
    return 'text';
  }
  return 'file';
}

function readTextPrefix(path: string, maxBytes: number): { text: string; truncated: boolean } {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    return { text: buf.subarray(0, n).toString('utf8'), truncated: statSync(path).size > n };
  } finally {
    closeSync(fd);
  }
}

/** 纯 handler（不依赖 electron；便于内存库单测）。 */
export function handleResolveAttachment(deps: AttachmentResolveDeps, raw: unknown): AttachmentPreviewResult {
  if (!deps.db) return bad('preview_unavailable', '附件解析不可用（主进程未装配数据库）');
  if (!deps.stagedFilesDir) return bad('preview_unavailable', '附件解析不可用（未配置暂存目录）');
  const input = (raw ?? {}) as { messageId?: unknown; index?: unknown };
  const messageId = Number(input.messageId);
  const index = Number(input.index);
  if (!Number.isInteger(messageId) || messageId <= 0 || !Number.isInteger(index) || index < 0) {
    return bad('bad_request', 'messageId / index 必须是有效整数');
  }

  const row = getHumanMessage(deps.db, messageId);
  if (!row) return bad('not_found', '消息不存在');
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.attachments);
  } catch {
    return bad('not_found', '消息附件记录不可解析');
  }
  if (!Array.isArray(parsed)) return bad('not_found', '消息没有附件');
  const meta = parsed[index] as AttachmentMetaLike | undefined;
  if (!meta || typeof meta !== 'object') return bad('not_found', '附件下标不存在');

  const name = typeof meta.name === 'string' ? meta.name : '';
  const fileToken = typeof meta.fileToken === 'string' ? meta.fileToken : '';
  if (name.length === 0) return bad('not_found', '附件缺少文件名');
  if (fileToken.length === 0) return bad('not_found', '附件缺少暂存令牌');

  const dir = deps.stagedFilesDir();
  const path = stagedFilePath(dir, fileToken, name);
  if (!path) return bad('not_found', '附件文件不存在或已清理');

  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return bad('not_found', '附件文件不可读');
  }
  const type = inferType(name, meta.type);
  const kind = kindFor(name, type);
  const base = { name, size, type, previewable: kind !== 'file' };

  if ((kind === 'image' || kind === 'pdf') && size <= MAX_PREVIEW_BYTES) {
    const token = createPreviewToken({ path, name, type });
    return {
      ok: true,
      attachment: { ...base, kind, url: `aico-file://preview/${token}` },
    };
  }

  if (kind === 'text') {
    try {
      const { text, truncated } = readTextPrefix(path, MAX_TEXT_BYTES);
      return { ok: true, attachment: { ...base, kind, text, truncated } };
    } catch {
      return bad('preview_failed', '文本附件读取失败');
    }
  }

  // 大文件/二进制/不支持的类型：只回元信息（不返回路径，也不假装有预览）。
  return { ok: true, attachment: { kind: 'file', name, size, type, previewable: false } };
}
