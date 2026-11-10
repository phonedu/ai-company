/**
 * （2026-11-05）：真语义分类器——幕僚长「听得懂自然话」的地基。
 *
 * 背景：`deps.classify` 从未注入，`defaultClassify`（一律 'chat'）是唯一实现——
 * 频道/IM 自由文本派任务整条链失效（T8b 真机实证：连「建任务：…」都退化成闲聊）。
 *
 * 口径（设计三原则）：
 *  1. **轻量**：单次 JSON completion（无工具、无历史、短超时）——分诊不该比正文贵；
 *  2. **绝不误建**：任何失败（无 Key/超时/坏 JSON/未知 intent）→ 回落 `{intent:'chat'}`；
 *  3. **可换**：依赖全注入（fetch/secretsDir/db），测试可打桩。
 *
 * 已知端点（v1 只内置 deepseek；其余供应商无已证实的 OpenAI 兼容端点，不猜 URL）。
 */
import type { Classify, Inbound, SemanticSignal } from '../../core/resolver.js';
import { resolveProviderKey } from './provider-keys.js';
import type { SqliteDb } from '../db/open.js';

const BASE_URLS: Record<string, string> = {
  deepseek: 'https://api.deepseek.com/v1',
};

const INTENTS: ReadonlySet<string> = new Set(['new_task', 'query', 'chat', 'work', 'command']);

const SYSTEM_PROMPT = `你是「AI 一人公司」的消息分诊器。老板会在频道里说自然的话，你要判断意图。
只输出一个 JSON 对象（无代码块、无解释）：
{"intent":"new_task|query|chat|work|command","confidence":0到1,"projectId":数字或省略,"titleGuess":"任务标题猜测（仅 new_task 时给，≤20字）"}
规则：
- 明确要创建任务/让员工做一件事 → intent="new_task"，projectId 从项目列表里选最相关的；拿不准就省略 projectId。
- 询问任务状态/某个文件/某个内容 → intent="query"。
- 让正在跑的任务继续/调整 → intent="work"。
- 普通聊天/提问你回答 → intent="chat"。
- 拿不准 → intent="chat"，confidence 给低值。`;

export function extractJsonLoose(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  const end = text.lastIndexOf('}');
  if (end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function clamp01(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

export interface SemanticClassifierOptions {
  db?: SqliteDb | null;
  /** 本机 secrets 目录（缺省 ~/.aico/secrets；测试注入临时目录）。 */
  secretsDir?: () => string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createSemanticClassifier(options: SemanticClassifierOptions): Classify {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8000;
  return async (inbound: Inbound): Promise<SemanticSignal> => {
    const fallback: SemanticSignal = { intent: 'chat', confidence: 0.5 };
    try {
      // 选供应商：v1 只内置已证实端点的 deepseek；无 Key → 回落（不猜其它 URL）。
      const cred = resolveProviderKey('deepseek', options.secretsDir ? { baseDir: options.secretsDir() } : undefined);
      if (cred == null || cred.key.trim().length === 0) return fallback;
      const baseUrl = BASE_URLS[cred.provider];
      if (baseUrl == null) return fallback;

      // 项目列表（供 projectId 归属）＋当前频道范围（落库的 scope 键）
      let projectLines = '';
      let scopeId: number | null = null;
      const db = options.db;
      if (db != null) {
        const rows = db
          .prepare('SELECT id, name FROM projects WHERE archived = 0 ORDER BY id LIMIT 20')
          .all() as Array<{ id: number; name: string }>;
        projectLines = rows.map((p) => `- ${p.id}: ${p.name}`).join('\n');
        try {
          const scope = db
            .prepare("SELECT value FROM settings WHERE key = 'channel.scope_project_id'")
            .get() as { value?: unknown } | undefined;
          const n = scope?.value != null ? Number(scope.value) : NaN;
          if (Number.isInteger(n) && n > 0) scopeId = n;
        } catch { /* 无该设置 → 无范围 */ }
      }

      const user = [
        `【老板消息】${inbound.text}`,
        projectLines.length > 0 ? `【项目列表】\n${projectLines}` : '【项目列表】（空）',
        scopeId != null ? `【当前频道范围项目 id】${scopeId}` : '【当前频道范围项目 id】（无）',
      ].join('\n\n');

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let text = '';
      try {
        const resp = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          signal: ctrl.signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cred.key}` },
          body: JSON.stringify({
            model: 'deepseek-chat',
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: user },
            ],
            temperature: 0,
            max_tokens: 200,
          }),
        });
        if (!resp.ok) return fallback;
        const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
        text = data.choices?.[0]?.message?.content ?? '';
      } finally {
        clearTimeout(timer);
      }

      const parsed = extractJsonLoose(text);
      if (parsed == null) return fallback;
      const intent = typeof parsed.intent === 'string' ? parsed.intent : '';
      if (!INTENTS.has(intent)) return fallback;
      const confidence = clamp01(parsed.confidence) ?? 0.5;
      const signal: SemanticSignal = {
        intent: intent as SemanticSignal['intent'],
        confidence,
      };
      if (typeof parsed.titleGuess === 'string' && parsed.titleGuess.trim().length > 0) {
        signal.titleGuess = parsed.titleGuess.trim().slice(0, 20);
      }
      // projectId 必须在项目列表里（防幻觉 id）；无则省略让 resolver 走范围/默认。
      if (typeof parsed.projectId === 'number' && Number.isInteger(parsed.projectId) && parsed.projectId > 0) {
        const known = projectLines.split('\n').some((line) => line.startsWith(`- ${parsed.projectId}: `));
        if (known) signal.projectId = parsed.projectId;
      }
      // new_task 且分类器没给归属 → 用频道范围（比「最后接入的默认项目」更贴近老板意图）。
      if (signal.intent === 'new_task' && signal.projectId == null && scopeId != null) signal.projectId = scopeId;
      return signal;
    } catch {
      return fallback;
    }
  };
}
