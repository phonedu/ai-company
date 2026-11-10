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
 *  接线审查：ctx **给了**但取不到 cwd（runner 失活等）时响亮报错再回落——静默回落正是本次修的病灶形态，
 * 真机上必须可见；ctx 没给（单测/无上下文）不算异常，不响。
 */
export function sessionCwd(ctx: unknown, fallback: string): string {
  try {
    if (ctx != null && typeof ctx === 'object') {
      const cwd = (ctx as { cwd?: unknown } | null | undefined)?.cwd;
      if (typeof cwd === 'string' && cwd.length > 0) return cwd;
      console.error('[tools] 会话上下文存在但取不到 cwd → 回落装配期目录（生产应＝会话 cwd，请排查 runner 状态）');
      return fallback;
    }
  } catch {
    console.error('[tools] 会话 cwd 读取失败（runner 失活？）→ 回落装配期目录');
  }
  return fallback;
}
