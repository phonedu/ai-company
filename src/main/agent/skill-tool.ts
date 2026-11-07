/**
 * GAP7（M3-N-3）· `load_skill` customTool —— 技能**按需披露**的加载口。
 *
 * 口径：
 *  - system prompt 只放「技能索引」（name + description）；
 *  - 模型需要时调用 `load_skill(name)` 读某一技能的 `SKILL.md` 全文；
 *  - **白名单按会话**：`setSessionSkillRefs(sessionId, refs)` 由运行时在每轮 run 前写入
 *    （来源＝员工勾选 ∪ 项目默认 ∪ 任务强制），工具只读本会话名单——**员工看不到别人的技能**；
 *  - 文件读不到/超限/不在名单 → 显式错误回执（不编内容）。
 *
 * ESM/CJS 约束：Pi 包 ESM-only，主进程是 CJS ⇒ 异步工厂内动态 import（同其它工具）。
 */
import { readFileSync } from 'node:fs';

import { wrapExternalData } from './data-boundary.js';
import type { SkillRef } from './types.js';

const SKILL_MAX_CHARS = 20_000;
const bySession = new Map<string, readonly SkillRef[]>();

export function setSessionSkillRefs(sessionId: string, refs: readonly SkillRef[] | undefined): void {
  if (!sessionId) return;
  bySession.set(sessionId, refs ?? []);
}

export function getSessionSkillRefs(sessionId: string): readonly SkillRef[] {
  return bySession.get(sessionId) ?? [];
}

/** 测试/装配清理用（不常驻泄漏）。 */
export function clearSessionSkillRefs(): void {
  bySession.clear();
}

export async function createLoadSkillTool() {
  const [{ defineTool }, { Type }] = await Promise.all([
    import('@earendil-works/pi-coding-agent'),
    import('@earendil-works/pi-ai'),
  ]);
  return defineTool({
    name: 'load_skill',
    label: 'Load Skill',
    description:
      '按名字加载本会话可用的技能全文（技能索引只给用途；需要具体做法时调用）。只能加载分配给你的技能；返回 SKILL.md 内容。',
    parameters: Type.Object({
      name: Type.String({ description: '技能名（技能索引里的 name）' }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = ctx?.sessionManager?.getSessionId?.() ?? '';
      const refs = getSessionSkillRefs(sessionId);
      const ref = refs.find((r) => r.name === params.name.trim());
      if (!ref) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `技能不可用：${params.name}（不在本会话的技能集内；不能加载别人的技能）`,
            },
          ],
          details: { name: params.name, loaded: false },
          isError: true,
        };
      }
      try {
        const content = readFileSync(ref.path, 'utf8');
        const clipped = content.length > SKILL_MAX_CHARS;
        return {
          content: [
            {
              type: 'text' as const,
              text: wrapExternalData(
                `【技能：${ref.name}】`,
                `${content.slice(0, SKILL_MAX_CHARS)}${clipped ? '\n…（已截断）' : ''}`,
              ),
            },
          ],
          details: { name: ref.name, loaded: true, chars: content.length, truncated: clipped },
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `技能文件读不到：${ref.name}（${error instanceof Error ? error.message : String(error)}）`,
            },
          ],
          details: { name: ref.name, loaded: false },
          isError: true,
        };
      }
    },
  });
}
