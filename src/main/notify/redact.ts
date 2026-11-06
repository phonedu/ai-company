/**
 * OPT-EXT-1 · 通知载荷脱敏（`src/main/notify/`）。
 *
 * 口径（2894/2918）：**通知载荷不得含密钥/令牌，也不得含绝对用户路径**。
 * 纯函数、**不改调用方对象**（深拷贝改写）；与 `agent/raw-conversation.ts#redactArgsDigest` 同族。
 */

/** 敏感键名（命中则整值替换为 `«redacted»`）。 */
export const SENSITIVE_KEY = /(api[_-]?key|secret|token|password|passwd|authorization|credential|bearer)/i;

const SK_RE = /\bsk-[A-Za-z0-9_-]{6,}/g;
const BEARER_VALUE_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

/** 文本级脱敏：`sk-…` / `Bearer …` → 占位。 */
export function maskSecrets(text: string): string {
  return text.replace(BEARER_VALUE_RE, 'Bearer «redacted»').replace(SK_RE, '«redacted»');
}

/** 绝对路径归一：**保留 basename**（便于排查）、**去掉用户/目录前缀** → `<abs>/<basename>`。 */
export function normalizeAbsPath(value: string): string {
  return value.replace(/(?:[A-Za-z]:\\[^\s"']+|\/(?:home|Users)\/[^\s"']+|\/[^\s"']+\.\w+)/g, (m) => {
    const parts = m.split(/[\\/]+/).filter((s) => s.length > 0);
    const base = parts.length > 0 ? parts[parts.length - 1] : m;
    return `<abs>/${base}`;
  });
}

function redactString(value: string): string {
  return normalizeAbsPath(maskSecrets(value));
}

/** 深拷贝改写：敏感键整值替换；字符串脱敏 + 路径归一。 */
export function redactPayload(payload: unknown): unknown {
  if (typeof payload === 'string') return redactString(payload);
  if (Array.isArray(payload)) return payload.map(redactPayload);
  if (payload && typeof payload === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '«redacted»' : redactPayload(v);
    }
    return out;
  }
  return payload;
}
