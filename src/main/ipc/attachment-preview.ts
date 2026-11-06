/**
 * 附件预览令牌（`aico-file://preview/<token>`）的**内存短票**。
 *
 * 为什么不直接把 `fileToken` 塞进 URL：
 *  - `chat:list` 已经把 fileToken 给了渲染层；若 URL 复用它，渲染层可凭任意 token 构造预览 URL。
 *  - 这里按「消息 + 下标」现签一个 5 分钟有效、不可猜测的随机 token；主进程只认自己签出的票。
 *  - 令牌只活在主进程内存；重启后旧 URL 失效，重新点附件会再签一张。
 */
import { randomUUID } from 'node:crypto';

export interface PreviewEntry {
  path: string;
  name: string;
  type: string;
  expiresAt: number;
}

export const PREVIEW_TOKEN_TTL_MS = 5 * 60 * 1000;
const previews = new Map<string, PreviewEntry>();

function sweep(now: number): void {
  for (const [token, entry] of previews) {
    if (entry.expiresAt <= now) previews.delete(token);
  }
}

/** 签一张预览票；返回随机 token（不含路径/文件 token）。 */
export function createPreviewToken(entry: Omit<PreviewEntry, 'expiresAt'>, now = Date.now()): string {
  sweep(now);
  const token = randomUUID();
  previews.set(token, { ...entry, expiresAt: now + PREVIEW_TOKEN_TTL_MS });
  return token;
}

/** 查票；过期/不存在 → null。 */
export function resolvePreviewToken(token: string, now = Date.now()): PreviewEntry | null {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) return null;
  const entry = previews.get(token);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    previews.delete(token);
    return null;
  }
  return entry;
}

/** 测试/退出清理用。 */
export function clearPreviewTokens(): void {
  previews.clear();
}
