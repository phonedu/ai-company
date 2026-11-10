/**
 * / · 记忆抽取提议卡（fail-closed）。
 *
 * 口径：工作项完成时，从员工提交的 summary 抽取**候选事实**（LLM 单发 JSON——与
 * semantic-classifier 同哲学：轻量/绝不误建/可换）；候选以 **provisional** 状态写
 * `memory_items`（08-记忆设计 §7 既有闸门），**老板在记忆页确认才 active**。
 * 无 Key/超时/坏 JSON/空候选 → 空数组（不猜测写入、不静默——调用方落 `memory_extract_failed`
 * 留痕）。抽取本身有成本上限（max_tokens 300）。
 */
import { resolveProviderKey } from './provider-keys.js';

/** 提取候选的结构（写 memory_items 前的内存形态）。 */
export interface MemoryCandidate {
  content: string;
  confidence: number;
}

const BASE_URLS: Record<string, string> = {
  deepseek: 'https://api.deepseek.com/v1',
};

const SYSTEM_PROMPT = `你是记忆抽取器。从员工工作汇报里抽取值得长期记住的**事实**（项目约定/结论/数据/踩坑），不抽过程性叙述。
只输出一个 JSON 对象（无代码块）：{"candidates":[{"content":"事实（一句话、可独立成立）","confidence":0到1}]}
规则：最多 3 条；没有值得记的就给 {"candidates":[]}；不编造、不概括未出现的内容。`;

/** 容错 JSON 解析（与 semantic-classifier extractJsonLoose 同哲学；独立实现避免互相依赖）。 */
export function parseCandidateJson(text: string): MemoryCandidate[] {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (parsed == null || typeof parsed !== 'object') return [];
    const raw = (parsed as { candidates?: unknown }).candidates;
    if (!Array.isArray(raw)) return [];
    const out: MemoryCandidate[] = [];
    for (const item of raw.slice(0, 3)) {
      if (item == null || typeof item !== 'object') continue;
      const content = String((item as { content?: unknown }).content ?? '').trim();
      const confidence = Number((item as { confidence?: unknown }).confidence ?? 0.5);
      if (content.length === 0 || content.length > 300) continue;
      out.push({ content, confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5 });
    }
    return out;
  } catch {
    return [];
  }
}

export interface ExtractMemoryCandidatesInput {
  text: string;
  /** 本机 secrets 目录（缺省 ~/.aico/secrets；测试注入临时目录）。 */
  secretsDir?: () => string;
  /** 测试注入：直传 Key（优先于 secretsDir；生产不传）。 */
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** 抽取候选；fail-closed：任何失败 → 空数组（调用方留痕，不写库）。 */
export async function extractMemoryCandidates(input: ExtractMemoryCandidatesInput): Promise<MemoryCandidate[]> {
  const text = (input.text ?? '').trim();
  if (text.length === 0) return [];
  try {
    const cred = input.apiKey != null && input.apiKey.trim().length > 0
      ? { provider: 'deepseek', key: input.apiKey }
      : resolveProviderKey('deepseek', input.secretsDir ? { baseDir: input.secretsDir() } : undefined);
    if (cred == null || cred.key.trim().length === 0) return [];
    const baseUrl = BASE_URLS[cred.provider];
    if (baseUrl == null) return [];
    const fetchImpl = input.fetchImpl ?? fetch;
    const timeoutMs = input.timeoutMs ?? 12_000;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let content = '';
    try {
      const resp = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cred.key}` },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `【工作汇报】\n${text.slice(0, 3000)}` },
          ],
          temperature: 0,
          max_tokens: 300,
        }),
      });
      if (!resp.ok) return [];
      const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
      content = data.choices?.[0]?.message?.content ?? '';
    } finally {
      clearTimeout(timer);
    }
    return parseCandidateJson(content);
  } catch {
    return [];
  }
}

/** 抽取用 Key 是否可用（只读；供调用方决定是否留 `memory_extract_failed` 之外的「未配置」说明）。 */
export function memoryExtractKeyAvailable(secretsDir?: () => string): boolean {
  try {
    const cred = resolveProviderKey('deepseek', secretsDir ? { baseDir: secretsDir() } : undefined);
    return cred != null && cred.key.trim().length > 0;
  } catch {
    return false;
  }
}


/**
 * 候选 → `memory_items` **provisional** 写入（08-记忆设计 §7 闸门：要求才升级）。
 * 幂等：同任务（`source.ref = task:<id>`）重复执行不重复写（按 ref+content 查重）。
 * 写入失败不抛（抽取链路绝不反噬任务收尾），返回写入条数。
 */
export async function writeCandidatesAsProvisional(
  store: { remember(input: unknown): unknown },
  input: { taskId: number; projectId: number | null; candidates: MemoryCandidate[]; now: number },
): Promise<number> {
  let written = 0;
  for (const c of input.candidates) {
    try {
      store.remember({
        scope: input.projectId != null && input.projectId > 0 ? { type: 'project', projectId: input.projectId } : { type: 'global' },
        kind: 'fact',
        value: c.content,
        // /：抽取候选＝**provisional**（08-记忆设计 §7 闸门）；要求（confidence→confirmed）
        // 之后才进 brief。数值 confidence 只保留在 source.excerpt 里供排序参考。
        confidence: 'provisional',
        source: { type: 'task', ref: `task:${input.taskId}`, excerpt: `conf=${c.confidence}`, at: input.now },
        now: input.now,
      });
      written += 1;
    } catch (error) {
      console.error('[memory-extract] provisional 写入失败（跳过该条）', error);
    }
  }
  return written;
}
