/**
 * 附件暂存文件的**纯路径规则**（file-import 与 attachment 解析共用）。
 *
 * 铁律：renderer 只拿 `fileToken`，永远不拿路径；本模块只在主进程用。
 * 文件名由 token + 经过白名单化的扩展名生成，不信任原始文件名。
 */
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';

/** 只用"像扩展名"的字符串拼 staging 文件名；其余一律丢弃。 */
export function safeExtension(name: string): string {
  const ext = extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : '';
}

/** staging 文件名＝token + 安全扩展名（file-import 与解析端必须同一规则）。 */
export function stagedFileName(fileToken: string, name: string): string {
  return `${fileToken}${safeExtension(name)}`;
}

/** UUID token 形状校验（file-import 只生成 UUID；旧 token 不认，避免路径注入）。 */
export function isFileToken(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** 解析 staging 文件；token 非法/文件不存在 → null（不抛、不猜）。 */
export function stagedFilePath(dir: string, fileToken: string, name: string): string | null {
  if (!isFileToken(fileToken)) return null;
  const path = join(dir, stagedFileName(fileToken, name));
  return existsSync(path) ? path : null;
}
