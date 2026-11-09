/**
 * 自定义工具的**会话 cwd** 解析。
 *
 * 背景：员工运行时是**全局共享一份**（生产 `createLazyEmployeeRuntime({ cwd: process.cwd() })`），
 * 而每个工作项的 Pi 会话按 `sessionKey@cwd` 各自建（cwd＝项目根或 worktree/staging）。Pi 内置
 * read/write/bash 用的是会话 cwd；经 `extensionFactories` 注册的自定义工具若在装配期绑死
 * `options.cwd`，生产里拿到的是**应用进程目录**——读写落错地方，且与门禁按 `run.cwd` 判定的
 * 路径错位（门禁批 A、工具写 B）。
 *
 * 口径：Pi 每次 `execute` 传第 5 参 `ExtensionToolContext`，其 `cwd` 取自
 * `new ExtensionRunner(…, session._cwd, …)`——即**本会话**的工作目录，与门禁同源。
 * 装配期 cwd 只作兜底（单测/无上下文）。`cwd` 是 getter（`runner.assertActive()` 可能抛）⇒ 吞异常回落。
 */
export function sessionCwd(ctx: unknown, fallback: string): string {
  try {
    const cwd = (ctx as { cwd?: unknown } | null | undefined)?.cwd;
    return typeof cwd === 'string' && cwd.length > 0 ? cwd : fallback;
  } catch {
    return fallback;
  }
}
