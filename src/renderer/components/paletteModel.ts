// ─────────────────────────────────────────────────────────────────────────────
// 命令面板 · 纯逻辑（2026-10-18 真机反馈批，设计件 §4.9）：Ctrl K 搜索——**只搜已加载真数据**
//   （任务 `tasks.list` ／ 消息 `messages.list`）；产物组＝数据面（全局索引）未接，如实不摆假组。
//   抽出来可 node 测；面板组件（`CommandPalette.tsx`）只管画。
// ─────────────────────────────────────────────────────────────────────────────

export interface PaletteTaskItem {
  kind: 'task';
  id: number;
  /** 展示：`T-1042 · 标题`（短号缺失回落 `#id`）。 */
  label: string;
  /** 过滤用（短号＋标题小写）。 */
  haystack: string;
}

export interface PaletteMessageItem {
  kind: 'message';
  id: number;
  /** 展示：内容片段（单行、截 80）。 */
  label: string;
  haystack: string;
}

export interface PaletteResults {
  query: string;
  tasks: PaletteTaskItem[];
  messages: PaletteMessageItem[];
  /**  尾（G-D）：跨项目全局结果（任务/消息/产物；选中即打开对应任务）。 */
  global: PaletteGlobalItem[];
  /** 总命中数（0 ⇒ 面板显「没有匹配」空态——不摆假结果）。 */
  total: number;
}

export interface PaletteGlobalItem {
  kind: 'global';
  /** 唯一展示键（产物用 `artifact:<id>`，避免与任务 id 撞）。 */
  id: number;
  /** 打开哪个任务（消息无任务归属 → null ⇒ 去频道）。 */
  taskId: number | null;
  /** 产物命中保留真实 artifactId（选中后开预览；合成 id 只用于行 key）。 */
  artifactId?: number;
  label: string;
  /** 来源组（展示用：任务/消息/产物）。 */
  source: 'task' | 'message' | 'artifact';
}

const MAX_PER_GROUP = 6;

function clip(text: string, max = 80): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/**
 * 过滤（**大小写不敏感**；空查询 ⇒ 空结果——不主动罗列全库，防"打开即刷屏"）。
 * 任务按短号＋标题；消息按内容。每组至多 `MAX_PER_GROUP` 条。
 */
export function paletteResults(
  query: string,
  tasks: readonly { id: number; shortId?: string | null; title: string }[],
  messages: readonly { id: number; content: string }[],
  global?: {
    tasks: readonly { id: number; shortId: string | null; title: string; projectName: string | null }[];
    messages: readonly { id: number; taskId: number | null; content: string; projectName: string | null }[];
    artifacts: readonly { id: number; taskId: number; path: string; projectName: string | null }[];
  } | null,
): PaletteResults {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return { query: query.trim(), tasks: [], messages: [], global: [], total: 0 };
  const hit = (text: string): boolean => text.toLowerCase().includes(q);

  const taskItems: PaletteTaskItem[] = [];
  for (const task of tasks) {
    const short = task.shortId ?? `#${task.id}`;
    if (!hit(short) && !hit(task.title)) continue;
    taskItems.push({ kind: 'task', id: task.id, label: `${short} · ${task.title}`, haystack: `${short} ${task.title}`.toLowerCase() });
    if (taskItems.length >= MAX_PER_GROUP) break;
  }

  const messageItems: PaletteMessageItem[] = [];
  for (const message of messages) {
    if (!hit(message.content)) continue;
    messageItems.push({ kind: 'message', id: message.id, label: clip(message.content), haystack: message.content.toLowerCase() });
    if (messageItems.length >= MAX_PER_GROUP) break;
  }

  const globalItems: PaletteGlobalItem[] = [];
  if (global) {
    for (const task of global.tasks) {
      const label = `${task.shortId ?? `#${task.id}`} · ${task.title}${task.projectName ? ` · ${task.projectName}` : ''}`;
      if (!hit(label)) continue;
      globalItems.push({ kind: 'global', id: task.id, taskId: task.id, label, source: 'task' });
      if (globalItems.length >= MAX_PER_GROUP) break;
    }
    for (const message of global.messages) {
      if (globalItems.length >= MAX_PER_GROUP) break;
      if (!hit(message.content)) continue;
      globalItems.push({
        kind: 'global',
        id: -message.id,
        taskId: message.taskId,
        label: `${clip(message.content)}${message.projectName ? ` · ${message.projectName}` : ''}`,
        source: 'message',
      });
    }
    for (const artifact of global.artifacts) {
      if (globalItems.length >= MAX_PER_GROUP) break;
      const label = `${artifact.path}${artifact.projectName ? ` · ${artifact.projectName}` : ''}`;
      if (!hit(label)) continue;
      globalItems.push({ kind: 'global', id: -1_000_000 - artifact.id, taskId: artifact.taskId, artifactId: artifact.id, label, source: 'artifact' });
    }
  }

  return {
    query: query.trim(),
    tasks: taskItems,
    messages: messageItems,
    global: globalItems,
    total: taskItems.length + messageItems.length + globalItems.length,
  };
}
