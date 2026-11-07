/**
 * 检索词抽取（**单一真源**）：任务标题/目标/记忆查询共用。
 *
 * 中文没有空格：整句不可作为 LIKE 词，取 2 字滑窗（如「修渲染问题」→ 修复/修渲/渲染…）；
 * 英文/数字按空白切词。去重、按出现顺序、最多 `max` 个。
 *
 * 为什么单独成文件：`memory/store-sqlite.ts` 也要用它（ADV-1 P0-4）——若直接 import `db/retrieval`
 * 会把 `agent/notes` 拉进记忆模块（层级倒挂）；抽成纯函数模块两边共用。
 */
export function retrievalTerms(text: string, max = 4, options: { windows?: boolean } = {}): string[] {
  const cleaned = text.replace(/[^\p{L}\p{N}\s]+/gu, ' ').trim();
  if (cleaned.length === 0) return [];
  const terms: string[] = [];
  const push = (t: string): void => {
    const s = t.trim();
    if (s.length < 2 || terms.includes(s) || terms.length >= max) return;
    terms.push(s);
  };
  for (const word of cleaned.split(/\s+/)) {
    if (word.length >= 2) push(word);
    // 中文词没有空格：取 2 字滑窗（最多 3 个），让「修渲染」这类短语可命中。
    if (options.windows !== false && /\p{Script=Han}/u.test(word) && word.length > 2) {
      for (let i = 0; i + 2 <= word.length && terms.length < max; i += 1) push(word.slice(i, i + 2));
    }
  }
  return terms;
}
