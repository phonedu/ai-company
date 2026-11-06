/**
 * `OPT-AI-7`（M2-C）· **结构化提交的校验**（单一真源：工具侧与宿主侧共用）。
 *
 * 口径：
 *  - `summary` 必填、非空、≤ 500 字；
 *  - `artifacts` / `evidence` / `assumptions` / `unclosed` 可选，**字符串数组**（元素非空、≤ 500 字、各 ≤ 50 条）；
 *  - 非法 → **逐条人话错误**（工具侧把它抛回模型，模型可重交；宿主侧兜底落痕）；
 *  - **不静默**：多余字段保留在 `extra`（审计可见），但**不外泄为规范字段**。
 *
 * 纯函数、零依赖 —— 工具（`submit-work-item-tool.ts`）与宿主（`employee-executor.ts`）都调它，**禁抄第二遍**。
 */

export interface Submission {
  summary: string;
  artifacts: string[];
  evidence: string[];
  assumptions: string[];
  unclosed: string[];
  /** 契约外字段（原样保留，供审计；不作为规范字段使用）。 */
  extra: Record<string, unknown>;
}

export type SubmissionValidation = { ok: true; value: Submission } | { ok: false; errors: string[] };

const MAX_TEXT = 500;
const MAX_ITEMS = 50;
const KNOWN_KEYS = new Set(['summary', 'artifacts', 'evidence', 'assumptions', 'unclosed']);

function checkTextArray(name: string, raw: unknown, errors: string[]): string[] {
  if (raw === undefined || raw === null) return [];
  // 2026-10-17 MiMo 验收实测：模型常把单条 evidence 传成字符串（或 `{text}` 对象）；
  // 宽容归一为一条（不丢数据），仍保留长度/条数/空值校验；产物路径的空白校验在下面单独做。
  const normalized: unknown[] =
    typeof raw === 'string'
      ? [raw]
      : Array.isArray(raw)
        ? raw.map((item) =>
            item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string'
              ? (item as { text: string }).text
              : item,
          )
        : [];
  if (!Array.isArray(raw) && typeof raw !== 'string') {
    errors.push(`${name} 必须是字符串数组（也可传单条字符串）`);
    return [];
  }
  if (normalized.length > MAX_ITEMS) {
    errors.push(`${name} 最多 ${MAX_ITEMS} 条（收到 ${normalized.length} 条）`);
  }
  const out: string[] = [];
  for (const [i, item] of normalized.slice(0, MAX_ITEMS).entries()) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      errors.push(`${name}[${i}] 必须是非空字符串（或 {text:"…"}）`);
      continue;
    }
    if (item.length > MAX_TEXT) {
      errors.push(`${name}[${i}] 超过 ${MAX_TEXT} 字（${item.length}）`);
      continue;
    }
    out.push(item.trim());
  }
  return out;
}

export function validateSubmission(raw: unknown): SubmissionValidation {
  const errors: string[] = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['提交必须是一个对象（含 summary 字段）'] };
  }
  const record = raw as Record<string, unknown>;

  const summaryRaw = record.summary;
  if (typeof summaryRaw !== 'string' || summaryRaw.trim().length === 0) {
    errors.push('summary 必填（一句话结论）');
  } else if (summaryRaw.length > MAX_TEXT) {
    errors.push(`summary 超过 ${MAX_TEXT} 字（${summaryRaw.length}）`);
  }

  const artifacts = checkTextArray('artifacts', record.artifacts, errors);
  // BRK24（2026-10-16）：产物项 = **路径 / URL / 产出的文件名**——不得含空白/控制字符。
  // 狗粮实测：员工把「commit 86b8890」当产物路径提交 ⇒ 产物 tab 把提交号当文件列。
  // 非法项**逐条拒**并给人话指引（不静默改写、不阻塞其他项——模型可照提示重交）。
  const shapedArtifacts: string[] = [];
  for (const [i, item] of artifacts.entries()) {
    if (/\s/.test(item) || /[\u0000-\u001f\u007f]/.test(item)) {
      errors.push(
        `artifacts[${i}]「${item.length > 60 ? `${item.slice(0, 60)}…` : item}」含空白/控制字符——` +
          '产物项只放路径/URL/产出的文件名（说明文字放 summary/evidence；提交号由系统自己记录）',
      );
      continue;
    }
    shapedArtifacts.push(item);
  }
  const evidence = checkTextArray('evidence', record.evidence, errors);
  const assumptions = checkTextArray('assumptions', record.assumptions, errors);
  const unclosed = checkTextArray('unclosed', record.unclosed, errors);

  if (errors.length > 0) return { ok: false, errors };

  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) if (!KNOWN_KEYS.has(k)) extra[k] = v;

  return {
    ok: true,
    value: {
      summary: (summaryRaw as string).trim(),
      artifacts: shapedArtifacts,
      evidence,
      assumptions,
      unclosed,
      extra,
    },
  };
}
