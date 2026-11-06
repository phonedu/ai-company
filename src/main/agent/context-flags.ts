/**
 * CTX-1 · 总开关（A/B 单变量）：`AICO_CTX=off` 关闭全部上下文工程子项
 * （工具输出裁剪、按模型压缩阈值、压缩后交接块、计划复述）；默认开。
 *
 * 子项仍可单独关：`AICO_CTX_MASK=off` / `AICO_CTX_COMPACTION=off`。
 */
export function isCtxEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.AICO_CTX ?? '').trim().toLowerCase();
  return raw !== 'off' && raw !== '0' && raw !== 'false';
}
