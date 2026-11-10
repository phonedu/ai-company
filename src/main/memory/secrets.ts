/**
 * 记忆写入/注入的密钥检测（硬规则：不存密钥/凭据）。
 *
 * 口径：
 *  - **已知前缀**：sk-/sk_live/sk_test/rk_live、ghp_/github_pat_/glpat-、npm_、xapp-/xox*、AIza、AKIA；
 *  - **结构化**：Bearer、PEM 私钥、带账号密码的 URL；
 *  - **键值式**：api_key/token/secret/password/密码/密钥/凭据/令牌 + `:`/`：`/`=`/`＝`；
 *  - 负向：`risk-management` 这类普通词不得误判（`\b` + 足够长度）。
 */
export const SECRET_RE = new RegExp(
  [
    String.raw`\bsk-(?:live_|test_|proj_)?[A-Za-z0-9_-]{16,}`,
    String.raw`\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}`,
    String.raw`\bghp_[A-Za-z0-9_-]{16,}`,
    String.raw`\bgithub_pat_[A-Za-z0-9_]{16,}`,
    String.raw`\bglpat-[A-Za-z0-9_-]{16,}`,
    String.raw`\bnpm_[A-Za-z0-9]{16,}`,
    String.raw`\bxapp-[A-Za-z0-9-]{16,}`,
    String.raw`\bxox[baprs]-[A-Za-z0-9-]{8,}`,
    String.raw`\bAIza[A-Za-z0-9_-]{20,}`,
    String.raw`\bAKIA[0-9A-Z]{16}`,
    String.raw`Bearer\s+(?!(?:authentication|authorization|token)\b)[A-Za-z0-9._~+/-]{12,}`,
    String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----`,
    String.raw`[a-z][a-z0-9+.-]*://[^/\s:@]*:[^/\s@]+@`,
    String.raw`(?:api[_-]?key|credentials?|token|secret|password|passphrase|passwd|pwd|密钥|密码|口令|凭据|令牌)\s*[:：=＝]\s*\S+`,
  ].join('|'),
  'i',
);

export function containsSecret(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.length > 0 && SECRET_RE.test(text);
}

export function redactSecrets(text: string): string {
  return text.replace(new RegExp(SECRET_RE.source, 'gi'), '[redacted]');
}

export function assertNoSecret(fields: Array<string | null | undefined>): void {
  for (const field of fields) {
    if (containsSecret(field)) throw new Error('[memory] 疑似包含密钥/密码，拒绝写入');
  }
}
