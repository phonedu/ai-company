/**
 * 三类卡片 → 微信 1:1 文本降级。
 *
 * 只做「文字-only」：不发送附件、不发送员工内部对话。选项必须完整落在同一条消息里，
 * 避免把「1) 批准 2) 打回」切到两条。平台单条上限约 2000 字，这里控制在 1800 以内。
 */
export interface CardOption {
  key?: string;
  label?: string;
  recommended?: boolean;
}

export interface CardPayload {
  title?: string;
  shortId?: string;
  card?: string;
  question?: string;
  options?: CardOption[];
  planSteps?: string[];
  summary?: string;
  reason?: string;
  outcome?: string;
  verdict?: string;
  notes?: string;
}

const MAX_TEXT = 1800;
const MAX_STEPS = 5;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function parseCardPayload(raw: unknown): CardPayload {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const v = value as Record<string, unknown>;
  const options: CardOption[] = Array.isArray(v.options)
    ? v.options
        .map((item): CardOption | null => {
          if (!item || typeof item !== 'object') return null;
          const o = item as Record<string, unknown>;
          const key = str(o.key);
          const label = str(o.label);
          if (!key && !label) return null;
          return { ...(key ? { key } : {}), ...(label ? { label } : {}), recommended: o.recommended === true };
        })
        .filter((item): item is CardOption => item != null)
    : [];
  const planSteps = Array.isArray(v.planSteps)
    ? v.planSteps.map((s) => str(s)).filter((s): s is string => s != null).slice(0, MAX_STEPS)
    : [];
  return {
    ...(str(v.title) ? { title: str(v.title) } : {}),
    ...(str(v.shortId) ? { shortId: str(v.shortId) } : {}),
    ...(str(v.card) ? { card: str(v.card) } : {}),
    ...(str(v.question) ? { question: str(v.question) } : {}),
    ...(options.length > 0 ? { options } : {}),
    ...(planSteps.length > 0 ? { planSteps } : {}),
    ...(str(v.summary) ? { summary: str(v.summary) } : {}),
    ...(str(v.reason) ? { reason: str(v.reason) } : {}),
    ...(str(v.outcome) ? { outcome: str(v.outcome) } : {}),
    ...(str(v.verdict) ? { verdict: str(v.verdict) } : {}),
    ...(str(v.notes) ? { notes: str(v.notes) } : {}),
  };
}

function optionLines(options: CardOption[]): string {
  return options
    .slice(0, 6)
    .map((option, index) => {
      const label = option.label ?? option.key ?? `选项 ${index + 1}`;
      const recommended = option.recommended && !/（推荐）|\(推荐\)/.test(label);
      return `${index + 1}) ${label}${recommended ? '（推荐）' : ''}`;
    })
    .join('\n');
}

/**
 * `kind` = reports.kind（report|ask|alert）；`payload.card` 决定具体文案（approval|decision|report|alert）。
 */
export function formatCardText(kind: string, rawPayload: unknown): string {
  const payload = parseCardPayload(rawPayload);
  const card = payload.card ?? (kind === 'report' ? 'report' : kind === 'alert' ? 'alert' : 'decision');
  const header =
    card === 'approval'
      ? '【等你批准】'
      : card === 'decision'
        ? '【等你决策】'
        : card === 'permission'
          ? '【权限请求】'
          : card === 'report'
            ? '【完成】'
            : '【异常】';
  const rawTitle = payload.title ?? (payload.shortId ? `${payload.shortId}` : '有一件事需要你看');
  // 引擎的 title 已带「等你批准：/完成：」前缀；去掉后由 header 统一承担，避免双层标题。
  const title = rawTitle.replace(/^(等你批准|等你决策|完成|异常)\s*[:：]\s*/u, '');
  const lines: string[] = [`${header}${title}`];

  if (payload.question) lines.push('', truncate(payload.question, 600));
  if (payload.planSteps && payload.planSteps.length > 0) {
    lines.push('', '计划：', ...payload.planSteps.map((step) => `- ${truncate(step, 160)}`));
    if (payload.planSteps.length === MAX_STEPS) lines.push('- …（其余见桌面）');
  }
  if (card === 'report') {
    if (payload.verdict) {
      const verdict = payload.verdict === 'pass' ? '通过' : payload.verdict === 'fail' ? '未通过' : payload.verdict;
      lines.push('', `结论：${verdict}`);
    }
    const body =
      payload.summary ?? payload.notes ?? payload.reason ?? (payload.outcome === 'cancelled' ? '任务已取消。' : undefined);
    if (body) lines.push('', truncate(body, 600));
    else lines.push('', '详情见桌面「待我处理」。');
  }
  if (card === 'alert') {
    const body = payload.summary ?? payload.reason;
    if (body) lines.push('', truncate(body, 600));
    else lines.push('', '详情见桌面「待我处理」。');
  }

  const options = payload.options ?? [];
  if (options.length > 0 && (card === 'approval' || card === 'decision' || card === 'permission')) {
    lines.push('', optionLines(options), '', '回复 1/2，或引用本条消息回复。');
  } else if (card === 'decision') {
    // 决策卡可能没有预设选项（ask_owner/escalate）——明确指路，不诱导无效回复。
    lines.push('', '这张卡没有预设选项，请到桌面「待我处理」处理。');
  } else if (card === 'report') {
    lines.push('', '详情见桌面「待我处理」。');
  } else if (card === 'alert') {
    lines.push('', '详情见桌面「待我处理」。');
  }

  return truncate(lines.join('\n'), MAX_TEXT);
}

/** 老板回复/幕僚长长文按平台上限切块（优先换行，避免切断选项/句子）。 */
export function chunkText(text: string, max = MAX_TEXT): string[] {
  if (text.length <= max) return text.length > 0 ? [text] : [];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    if (rest.length <= max) {
      chunks.push(rest);
      break;
    }
    let cut = rest.lastIndexOf('\n', max);
    if (cut <= 0) cut = max;
    const piece = rest.slice(0, cut).trimEnd();
    if (piece.length > 0) chunks.push(piece);
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  return chunks;
}
