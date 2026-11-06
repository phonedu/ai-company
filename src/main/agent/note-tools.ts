/**
 * K1 幕僚长 `note_write` + `note_search` 工具（与 task_status 同模式）。
 *
 * note_write：老板说「记一下」→ 幕僚长直接写笔记到当前范围（选了项目→项目笔记；没选→全局）。
 * note_search：搜笔记/文档/产物（当前范围＋全局），只读。
 */
import type { SqliteDb } from '../db/open.js';
import { writeNote, safeNoteName, listNotes, type NoteItem } from './notes.js';

function projectRootFromScope(db: SqliteDb, projectId: number | null): string | null {
  if (projectId == null) return null;
  const row = db.prepare('SELECT root_dir FROM projects WHERE id = ?').get(projectId) as { root_dir: string } | undefined;
  return row?.root_dir ?? null;
}

function globalNotesDir(db: SqliteDb): string {
  const dbPath = db.name;
  return dbPath === ':memory:' ? join(process.cwd(), '.aico-notes') : join(dbPath, '..', 'notes');
}

import { join } from 'node:path';

export async function createNoteWriteTool(db: SqliteDb, getScopeProjectId: () => number | null) {
  const [{ defineTool }, { Type }] = await Promise.all([
    import('@earendil-works/pi-coding-agent'),
    import('@earendil-works/pi-ai'),
  ]);
  return defineTool({
    name: 'note_write',
    label: 'Write Note',
    description:
      '写入笔记到当前范围（选了项目→该项目笔记；没选→全局笔记）。老板说「记一下」时调用。' +
      '只记有价值的知识（决定/经验/步骤），不记任务报告。',
    parameters: Type.Object({
      name: Type.String({ description: '笔记文件名（不含 .md）' }),
      content: Type.String({ description: '笔记内容（Markdown）' }),
    }),
    async execute(_toolCallId, params) {
      const safe = safeNoteName(params.name);
      if (safe == null) {
        return { content: [{ type: 'text', text: `文件名不安全：${params.name}` }], details: { ok: false, path: '' } };
      }
      const projectId = getScopeProjectId();
      const projectDir = projectRootFromScope(db, projectId);
      const result = writeNote({ projectDir, globalDir: globalNotesDir(db), name: safe, content: params.content });
      if (result.ok) {
        const scope = projectDir != null ? '当前项目' : '全局';
        return { content: [{ type: 'text', text: `已存为${scope}笔记「${safe}」` }], details: { ok: true, path: result.path } };
      }
      return { content: [{ type: 'text', text: `写入失败：${result.error}` }], details: { ok: false, path: '' } };
    },
  });
}

export async function createNoteSearchTool(db: SqliteDb, getScopeProjectId: () => number | null) {
  const [{ defineTool }, { Type }] = await Promise.all([
    import('@earendil-works/pi-coding-agent'),
    import('@earendil-works/pi-ai'),
  ]);
  return defineTool({
    name: 'note_search',
    label: 'Search Notes',
    description:
      '搜索笔记/项目文档/任务产物（当前范围＋全局）。老板问「部署流程」「之前怎么决定的」时先查这个。',
    parameters: Type.Object({
      query: Type.String({ description: '搜索关键词' }),
    }),
    async execute(_toolCallId, params) {
      const rawProjects = db
        .prepare('SELECT id, name, root_dir FROM projects WHERE archived = 0')
        .all() as Array<{ id: number; name: string; root_dir: string }>;
      const projects = rawProjects.map((p) => ({ id: p.id, name: p.name, rootDir: p.root_dir }));
      const items = listNotes({ projects, globalDir: globalNotesDir(db) });
      const q = params.query.trim().toLowerCase();
      if (q.length === 0) {
        return { content: [{ type: 'text', text: '请提供搜索关键词。' }], details: { count: 0 } };
      }
      // searchText＝前 8KB 正文：老板问的词常在正文（如「部署流程」在第二行），只看首行摘要会漏。
      const matched = items
        .filter((i: NoteItem) => i.name.toLowerCase().includes(q) || (i.searchText ?? i.preview).toLowerCase().includes(q))
        .slice(0, 5);
      if (matched.length === 0) {
        return { content: [{ type: 'text', text: `没有找到与「${params.query}」相关的笔记/文档/产物。` }], details: { count: 0 } };
      }
      const typeLabel = (type: NoteItem['type']): string =>
        type === 'doc' ? '文档'
        : type === 'artifact' ? '产物'
        : type === 'media' ? '媒体'
        : type === 'text' ? '文本'
        : type === 'file' ? '文件'
        : '笔记';
      const lines = matched.map((i: NoteItem) => {
        const source = i.projectName != null ? `${i.projectName} · ${typeLabel(i.type)}` : `全局 · ${typeLabel(i.type)}`;
        return `- ${i.name}（${source}）：${i.preview}`;
      });
      return {
        content: [{ type: 'text', text: `找到 ${matched.length} 条：\n${lines.join('\n')}` }],
        details: { count: matched.length },
      };
    },
  });
}
