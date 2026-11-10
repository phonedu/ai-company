import type { ReactElement } from 'react';

import { ProseText } from './ProseText.js';

// ─────────────────────────────────────────────────────────────────────────────
// 「原始交流」（`` 前端部分）· **纯组件**（可 node 测，无 store 依赖）
//   规格：`` §7（`554` 时间线右上角「原始交流」；`565` 💭 思考默认折叠）
//   口径（2303 + 2328，**逐条写死**）：
//     ① `text` / `thinking` **各自成条**（思考条**不渲染气泡正文**；发言条只渲染气泡；互不兜底）；
//     ② `mentions` **显式 `number[]`** —— 渲染层**绝不解析 `text`**；
//     ③ `argsDigest` 由**主进程截断 + 脱敏**（渲染层**不展开**完整参数）；
//     ④ 排序 **`at` 升序、同 `at` 按 `id` 升序**；
//     ⑤ **缺数据 = 显式空态**（`raw-empty`），**绝不出现占位假气泡**；逐字段可缺；
//     ⑥ 本视图**只读**、只在本机（隐私 `UI §4.6`）。
// ─────────────────────────────────────────────────────────────────────────────

/** `role` 的**已知取值**；契约外的值 → 按 `system` 渲染但**原样显示 role**（不隐藏、不崩）。 */
export const RAW_ROLES = ['boss', 'employee', 'system'] as const;
export type RawRole = (typeof RAW_ROLES)[number];

export interface RawToolCallDTO {
  name: string;
  /** 主进程给的**摘要**（已截断/脱敏）；缺省 → chip 只显示 `name`。 */
  argsDigest?: string | null;
  ok: boolean;
  error?: string | null;
}

export interface RawItemDTO {
  /** 稳定 key：**`'<source>:<rowId>'` 字符串**（如 `'task_event:812'` / `'human_msg:33'`）。
   * **2641 定稿**：不能用 number —— `task_events` 与 `human_messages` 的自增 id 会碰撞。 */
  id: string;
  /** 契约外取值也允许（渲染层降级为 `system` 并原样显示）。 */
  role: RawRole | string;
  employeeId?: number | null;
  name?: string | null;
  /** 时间戳（渲染层排序用）。 */
  at: number;
  /** 发言条正文（**与 `thinking` 各自成条**）。 */
  text?: string | null;
  /** 思考条原文 → UI 侧默认折叠。 */
  thinking?: string | null;
  toolCall?: RawToolCallDTO | null;
  /** `@提及` 的员工号（**显式字段**；渲染层不解析文本）。 */
  mentions?: number[] | null;
}

const AVATAR: Record<string, string> = { boss: '🧑‍💼', employee: '🧑‍💻', system: '⚙️' };

/** 排序：`at` 升序，同 `at` 按 `id`（**字符串比较**，2641 定稿）；**不改原数组**。 */
export function sortRawItems(items: readonly RawItemDTO[]): RawItemDTO[] {
  return [...items].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 显示名：有 `name` 用 `name`；否则用 `员工#<id>`；都没有 → 退回 role 文本（**不臆造人名**）。 */
export function rawDisplayName(item: RawItemDTO): string {
  if (typeof item.name === 'string' && item.name.length > 0) return item.name;
  if (item.employeeId != null) return `员工#${item.employeeId}`;
  return item.role;
}

export function RawConversation({ items }: { items: readonly RawItemDTO[] }): ReactElement {
  const ordered = sortRawItems(items ?? []);
  if (ordered.length === 0) {
    // 缺数据 = 显式空态（绝不摆"看起来像真的"的假气泡）。
    return (
      <p className="td__empty" data-testid="raw-empty">
        本任务暂无原始交流。
      </p>
    );
  }
  return (
    <div className="td__raw" data-testid="raw-conversation" data-count={ordered.length}>
      {ordered.map((item) => (
        <RawRow key={item.id} item={item} />
      ))}
    </div>
  );
}

function RawRow({ item }: { item: RawItemDTO }): ReactElement {
  const known = (RAW_ROLES as readonly string[]).includes(item.role);
  const role = known ? item.role : 'system';
  const tool = item.toolCall ?? null;
  return (
    <div className="td__rawrow" data-testid="raw-row" data-role={item.role} data-known-role={known ? 'true' : 'false'}>
      <span className="td__rawavatar" aria-hidden="true">
        {AVATAR[role] ?? AVATAR.system}
      </span>
      <div className="td__rawbody">
        <span className="td__rawname" data-testid="raw-name">
          {rawDisplayName(item)}
          {known ? null : <span className="td__meta">（未知角色 {item.role}）</span>}
        </span>
        {/* 发言条：只在有 `text` 时渲染气泡（思考条**不**兜底成气泡） */}
        {item.text ? (
          <ProseText className="td__rawtext" testId="raw-bubble" text={item.text} />
        ) : null}
        {item.mentions && item.mentions.length > 0 ? (
          <span className="td__rawmentions" data-testid="raw-mentions">
            {item.mentions.map((id) => `@员工#${id}`).join(' ')}
          </span>
        ) : null}
        {/* 思考条：默认折叠（`<details>` 不带 `open`） */}
        {item.thinking ? (
          <details className="td__rawthink" data-testid="raw-thinking">
            <summary>💭 思考</summary>
            <p>{item.thinking}</p>
          </details>
        ) : null}
        {/* 工具 chip：`ok=false` → ⚠️ + error（失败可见） */}
        {tool ? (
          <span className="td__rawchip" data-testid="raw-toolchip" data-ok={tool.ok ? 'true' : 'false'}>
            {tool.ok ? `⌨️ ${tool.name}` : `⚠️ ${tool.name}`}
            {tool.argsDigest ? ` · ${tool.argsDigest}` : ''}
            {!tool.ok && tool.error ? ` · ${tool.error}` : ''}
          </span>
        ) : null}
      </div>
    </div>
  );
}
