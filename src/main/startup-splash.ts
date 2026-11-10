/**
 * 启动页与启动失败页（内联 data URL）。
 *
 * 为什么用 data URL：启动阶段**不能依赖网络栈/文件系统**——真实渲染层加载失败时（network
 * service 抖动、磁盘扫描慢），启动页仍必须能显示，否则就是白窗。页面只用内联 CSS，
 * 无脚本、无外部资源。
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function dataUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

const BASE_STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; display: flex; align-items: center; justify-content: center;
    background: #f2f2f2; color: #1c1c1c;
    font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    -webkit-user-select: none; user-select: none;
  }
  .wrap { display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 24px; max-width: 560px; }
  .brand { font-size: 20px; font-weight: 600; letter-spacing: .02em; }
  .hint { font-size: 13px; color: #6b6b6b; }
  .bar { width: 132px; height: 3px; border-radius: 2px; background: #dcdcdc; overflow: hidden; }
  .bar > i { display: block; width: 42%; height: 100%; border-radius: 2px; background: #8a8a8a; animation: slide 1.1s ease-in-out infinite; }
  @keyframes slide { 0% { transform: translateX(-110%); } 100% { transform: translateX(260%); } }
  @media (prefers-color-scheme: dark) {
    body { background: #1a1a1a; color: #e8e8e8; }
    .hint { color: #9a9a9a; }
    .bar { background: #333; }
    .bar > i { background: #8f8f8f; }
  }
`;

export function buildSplashDataUrl(): string {
  return dataUrl(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>AI 一人公司</title>
<style>${BASE_STYLE}</style></head>
<body><div class="wrap">
  <div class="brand">AI 一人公司</div>
  <div class="bar"><i></i></div>
  <div class="hint">正在启动…</div>
</div></body></html>`);
}

/**
 * 启动失败页：可读原因 + 诊断目录，不静默、不白屏。
 * 不提供「重试」按钮——渲染层 IPC 尚未可用时按钮不可靠；让用户重启是当前最诚实的出口。
 */
export function buildStartupErrorDataUrl(input: { reason: string; logDir: string }): string {
  const reason = escapeHtml(input.reason || '未知错误');
  const logDir = escapeHtml(input.logDir);
  return dataUrl(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>AI 一人公司 · 启动失败</title>
<style>${BASE_STYLE}
  .reason { font-size: 13px; line-height: 1.6; padding: 10px 12px; border-radius: 8px;
    background: rgba(128,128,128,.12); font-family: Consolas, "Courier New", monospace;
    white-space: pre-wrap; word-break: break-all; max-height: 40vh; overflow: auto; }
  .path { font-size: 12px; color: #6b6b6b; word-break: break-all; }
  @media (prefers-color-scheme: dark) { .path { color: #9a9a9a; } }
</style></head>
<body><div class="wrap">
  <div class="brand">启动失败</div>
  <div class="hint">渲染层没有加载成功。请关闭本窗口后重新打开应用。</div>
  <div class="reason">${reason}</div>
  <div class="path">诊断日志：${logDir}</div>
</div></body></html>`);
}
