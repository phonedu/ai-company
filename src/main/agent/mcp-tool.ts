/**
 * GAP6 / B5 · MCP 工具（员工会话侧）：
 *  - `mcp_list`：列出**本会话分配**的 server；direct/auto 列工具名，deferred/codemode **不预列**（用 tool_search）；
 *  - `tool_search`：按关键词发现分配 server 的工具（含 deferred），返回 description/schema（B5）；
 *  - `mcp_call`：调用某 server 的某工具（**external**，逐次过会话闸门；未分配/连不上/超时报错可见）。
 *
 * 白名单：`setSessionMcpServers(sessionId, names)` 由 `pi-runtime.run` 每轮写入（来源＝员工 `mcps`∩启用），
 * 与技能同样的会话隔离——**员工看不到未分配 server**。
 */
import type { SqliteDb } from '../db/open.js';
import { getMcpServerByName, listMcpServers } from '../db/mcp.js';
import { callMcpTool, listMcpTools, type McpToolInfo } from './mcp-client.js';

const bySession = new Map<string, readonly string[]>();

export function setSessionMcpServers(sessionId: string, names: readonly string[] | undefined): void {
  if (!sessionId) return;
  bySession.set(sessionId, names ?? []);
}

export function getSessionMcpServers(sessionId: string): readonly string[] {
  return bySession.get(sessionId) ?? [];
}

export function clearSessionMcpServers(): void {
  bySession.clear();
}

function isDeferred(exposure: string): boolean {
  return exposure === 'deferred' || exposure === 'codemode';
}

function allowedRows(db: SqliteDb, sessionId: string) {
  const names = new Set(getSessionMcpServers(sessionId));
  if (names.size === 0) return [];
  return listMcpServers(db).filter((row) => names.has(row.name));
}

function sessionIdOf(ctx: { sessionManager?: { getSessionId?: () => string } } | undefined): string {
  return ctx?.sessionManager?.getSessionId?.() ?? '';
}

export interface McpTools {
  mcpList: unknown;
  mcpCall: unknown;
  toolSearch: unknown;
}

export async function createMcpTools(db: SqliteDb): Promise<McpTools> {
  const [{ defineTool }, { Type }] = await Promise.all([
    import('@earendil-works/pi-coding-agent'),
    import('@earendil-works/pi-ai'),
  ]);

  const mcpList = defineTool({
    name: 'mcp_list',
    label: 'MCP List',
    description:
      '列出**分配给你**的 MCP server。direct/auto 直接列工具名；deferred/codemode 只显示 server（工具用 tool_search 按需发现）。连不上会如实带 error，不执行外部动作。',
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const rows = allowedRows(db, sessionIdOf(ctx));
      if (rows.length === 0) {
        return {
          content: [{ type: 'text', text: '（本会话未分配 MCP server；由老板在设置·MCP 分配给员工）' }],
          details: { servers: [] },
        };
      }
      const lines: string[] = [];
      for (const row of rows) {
        if (isDeferred(row.exposure)) {
          lines.push(`${row.name}（${row.transport}，${row.exposure}：工具名不预列，用 tool_search 查）`);
          continue;
        }
        const listed = await listMcpTools(row);
        if (!listed.ok) {
          lines.push(`${row.name}（${row.transport}）：ERROR ${listed.error}`);
          continue;
        }
        const names = listed.tools.map((t: McpToolInfo) => t.name).filter((n) => n.length > 0);
        lines.push(`${row.name}（${row.transport}）：${names.length > 0 ? names.join(', ') : '（无工具）'}`);
      }
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        details: { servers: rows.map((r) => ({ name: r.name, transport: r.transport, exposure: r.exposure })) },
      };
    },
  });

  const toolSearch = defineTool({
    name: 'tool_search',
    label: 'Tool Search',
    description:
      '在分配给你的 MCP server 里按关键词搜索工具（也覆盖 deferred/codemode 曝光）。返回 server/tool/description；includeSchema=true 时附入参 schema。用找到的名字再调 mcp_call。',
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: '关键词（空＝列出全部可用工具）' })),
      includeSchema: Type.Optional(Type.Boolean({ description: '是否返回 inputSchema（默认 false）' })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const rows = allowedRows(db, sessionIdOf(ctx));
      if (rows.length === 0) {
        return {
          content: [{ type: 'text', text: '（本会话未分配 MCP server；无可搜索工具）' }],
          details: { matches: [] },
        };
      }
      const q = (params.query ?? '').trim().toLowerCase();
      const matches: Array<{ server: string; tool: string; description: string; schema?: unknown }> = [];
      const errors: string[] = [];
      for (const row of rows) {
        const listed = await listMcpTools(row);
        if (!listed.ok) {
          errors.push(`${row.name}: ${listed.error}`);
          continue;
        }
        for (const tool of listed.tools) {
          const text = `${tool.name} ${tool.description ?? ''}`.toLowerCase();
          if (q.length > 0 && !text.includes(q)) continue;
          matches.push({
            server: row.name,
            tool: tool.name,
            description: tool.description ?? '',
            ...(params.includeSchema === true && tool.inputSchema !== undefined ? { schema: tool.inputSchema } : {}),
          });
        }
      }
      const lines = matches.map((m) => {
        const schema = m.schema !== undefined ? `\nschema=${JSON.stringify(m.schema).slice(0, 3000)}` : '';
        return `${m.server}/${m.tool}${m.description ? ` — ${m.description}` : ''}${schema}`;
      });
      if (errors.length > 0) lines.push(`不可用 server：${errors.join('；')}`);
      return {
        content: [{ type: 'text', text: lines.length > 0 ? lines.join('\n') : '（没有匹配的 MCP 工具）' }],
        details: { matches: matches.map(({ schema: _schema, ...rest }) => rest), errors },
      };
    },
  });

  const mcpCall = defineTool({
    name: 'mcp_call',
    label: 'MCP Call',
    description:
      '调用分配给你的 MCP server 的一个工具。server = 名称；tool = 工具名（可先用 mcp_list/tool_search 查）；arguments = 工具入参对象。对外动作会先经老板逐次批准。',
    parameters: Type.Object({
      server: Type.String({ description: '已分配给本会话的 MCP server 名' }),
      tool: Type.String({ description: '工具名' }),
      arguments: Type.Optional(Type.Object({}, { additionalProperties: true, description: '工具入参（对象）' })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = sessionIdOf(ctx);
      if (!getSessionMcpServers(sessionId).includes(params.server)) {
        return {
          content: [{ type: 'text', text: `MCP server 未分配给本会话：${params.server}（不能调用别人的 server）` }],
          details: { error: 'server_not_assigned' },
          isError: true,
        };
      }
      const row = getMcpServerByName(db, params.server);
      if (!row || row.enabled !== 1) {
        return {
          content: [{ type: 'text', text: `MCP server 未注册/未启用：${params.server}（先用 mcp_list 看可用项）` }],
          details: { error: 'server_not_found' },
          isError: true,
        };
      }
      const args = params.arguments && typeof params.arguments === 'object' ? (params.arguments as Record<string, unknown>) : {};
      const result = await callMcpTool(row, params.tool, args);
      if (!result.ok) {
        return {
          content: [{ type: 'text', text: `MCP 调用失败（${params.server}/${params.tool}）：${result.error}` }],
          details: { error: result.error },
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
          },
        ],
        details: result.raw,
      };
    },
  });

  return { mcpList, mcpCall, toolSearch };
}
