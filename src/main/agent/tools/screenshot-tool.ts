/**
 * B4-1/D-29 · Screenshot——截取屏幕/指定区域（走 external ask 闸门）。
 *
 * 口径：Electron `desktopCapturer` 或系统命令截屏；截图落盘到项目临时目录；
 * 返回文件路径（员工上下文可引用图片路径给 vision 模型分析）。
 * PoC 阶段只做全屏截图；窗口/区域截图随后续迭代。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { SqliteDb } from '../../db/open.js';

export interface ScreenshotResult {
  ok: boolean;
  path?: string;
  error?: string;
}

/**
 * 全屏截图。跨平台：
 *  - Windows：PowerShell `System.Drawing` 截屏（无需管理员）。
 *  - macOS/Linux：`screencapture` / `import`（ImageMagick）。
 * PoC 阶段只做全屏 PNG；输出目录由调用方指定（临时目录或项目 .aico/screenshots/）。
 */
export function captureScreenshot(outputDir: string): ScreenshotResult {
  try {
    mkdirSync(outputDir, { recursive: true });
    const filename = `screenshot-${Date.now()}.png`;
    const outputPath = join(outputDir, filename);
    const platform = process.platform;

    if (platform === 'win32') {
      const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$i = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($i)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$i.Save('${outputPath.replace(/\\/g, '\\\\')}')
$g.Dispose(); $i.Dispose()
`;
      execFileSync('powershell', ['-NoProfile', '-Command', script], { timeout: 15_000 });
    } else if (platform === 'darwin') {
      execFileSync('screencapture', ['-x', outputPath], { timeout: 15_000 });
    } else {
      execFileSync('import', ['-window', 'root', outputPath], { timeout: 15_000 });
    }

    if (!existsSync(outputPath)) return { ok: false, error: '截图文件未生成' };
    return { ok: true, path: outputPath };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
