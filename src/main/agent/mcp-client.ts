/**
 * OPT-AI-10 · 最小 MCP 客户端（stdio / http；**短连**：initialize → tools/list|call → 关闭）。
 *
 * 口径：
 *  - 不引第三方 MCP SDK（依赖白名单）；JSON-RPC 2.0 手写，stdio 用换行分隔 JSON；HTTP 用 `fetch`；
 *  - **逐次批准**由会话工具闸门负责（`mcp_call` 归类 external）；本文件只管协议；
 *  - 连不上/超时/协议错 → 明确错误（调用方给模型/老板看，不静默）。
 */
import { spawn, spawnSync } from 'node:child_process';

import type { McpServerRow } from '../db/mcp.js';

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export type McpListResult = { ok: true; tools: McpToolInfo[] } | { ok: false; error: string };
export type McpCallResult = { ok: true; content: unknown; raw: unknown } | { ok: false; error: string };

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

function serverArgs(row: McpServerRow): string[] {
  try {
    const parsed = JSON.parse(row.args) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function serverEnv(row: McpServerRow): Record<string, string> {
  try {
    const parsed = JSON.parse(row.env) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v;
    return out;
  } catch {
    return {};
  }
}

function rpcError(response: JsonRpcResponse): string | null {
  if (!response.error) return null;
  return `${response.error.code ?? 'error'}: ${response.error.message ?? 'MCP error'}`;
}

/** 发送一次请求并等同 id 响应（stdio）。 */
function makeStdioRequester(child: ReturnType<typeof spawn>, timeoutMs: number) {
  let nextId = 1;
  let buffer = '';
  const pending = new Map<number, { resolve: (v: JsonRpcResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  const failAll = (error: Error): void => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    pending.clear();
  };
  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length > 0) {
        try {
          const msg = JSON.parse(line) as JsonRpcResponse;
          if (typeof msg.id === 'number' && pending.has(msg.id)) {
            const p = pending.get(msg.id);
            if (p) {
              pending.delete(msg.id);
              clearTimeout(p.timer);
              p.resolve(msg);
            }
          }
        } catch {
          // 非 JSON 行（服务端日志）忽略；协议错误由超时兜底并如实报错
        }
      }
      index = buffer.indexOf('\n');
    }
  });
  child.stderr?.on('data', () => undefined); // 不吞：超时错误里带 stderr 摘要
  child.on('error', (error) => failAll(error instanceof Error ? error : new Error(String(error))));
  child.on('exit', (code) => failAll(new Error(`MCP 进程提前退出（code=${code ?? 'null'}）`)));

  const request = (method: string, params?: unknown): Promise<JsonRpcResponse> => {
    const id = nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin?.write(`${payload}\n`);
    });
  };
  const notify = (method: string, params?: unknown): void => {
    child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) })}\n`);
  };
  return { request, notify, failAll };
}

/** 结束 stdio MCP 子进程树（Windows 下 `child.kill()` 不杀孙进程，会留孤儿）。 */
function killChildTree(child: ReturnType<typeof spawn>): void {
  try {
    if (process.platform === 'win32' && child.pid) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      return;
    }
  } catch {
    // 回落 child.kill
  }
  try {
    child.kill();
  } catch {
    // 已退出
  }
}

async function withStdio<T>(
  row: McpServerRow,
  timeoutMs: number,
  run: (rpc: ReturnType<typeof makeStdioRequester>) => Promise<T>,
): Promise<T> {
  if (!row.command) throw new Error(`stdio MCP 缺少 command：${row.name}`);
  const child = spawn(row.command, serverArgs(row), {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ...serverEnv(row) },
  });
  const rpc = makeStdioRequester(child, timeoutMs);
  try {
    return await run(rpc);
  } finally {
    rpc.failAll(new Error('MCP 会话已关闭'));
    killChildTree(child);
  }
}

async function handshake(rpc: ReturnType<typeof makeStdioRequester>): Promise<void> {
  const init = await rpc.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'ai-company', version: '0.0.1' },
  });
  const err = rpcError(init);
  if (err) throw new Error(err);
  rpc.notify('notifications/initialized');
}

/** HTTP MCP：initialize 取 session id → notifications/initialized（tools/list 与 tools/call 共用）。 */
async function httpHandshake(
  url: string,
  timeoutMs: number,
): Promise<{ ok: true; sessionId: string | null } | { ok: false; error: string }> {
  const init = await httpRpc(
    url,
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ai-company', version: '0.0.1' } },
    },
    null,
    timeoutMs,
  );
  const initErr = rpcError(init.response);
  if (initErr) return { ok: false, error: initErr };
  await httpRpc(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, init.sessionId, timeoutMs).catch(
    () => undefined,
  );
  return { ok: true, sessionId: init.sessionId };
}

export async function listMcpTools(row: McpServerRow, timeoutMs = 15_000): Promise<McpListResult> {
  try {
    if (row.transport === 'stdio') {
      return await withStdio(row, timeoutMs, async (rpc) => {
        await handshake(rpc);
        const res = await rpc.request('tools/list', {});
        const err = rpcError(res);
        if (err) return { ok: false, error: err };
        const tools = (res.result as { tools?: unknown } | undefined)?.tools;
        return {
          ok: true,
          tools: Array.isArray(tools)
            ? tools
                .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
                .map((t) => ({
                  name: String(t.name ?? ''),
                  ...(typeof t.description === 'string' ? { description: t.description } : {}),
                  ...(t.inputSchema !== undefined ? { inputSchema: t.inputSchema } : {}),
                }))
                .filter((t) => t.name.length > 0)
            : [],
        };
      });
    }
    if (row.transport === 'http') {
      if (!row.url) return { ok: false, error: `http MCP 缺少 url：${row.name}` };
      const hs = await httpHandshake(row.url, timeoutMs);
      if (!hs.ok) return { ok: false, error: hs.error };
      const res = await httpRpc(
        row.url,
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        hs.sessionId,
        timeoutMs,
      );
      const err = rpcError(res.response);
      if (err) return { ok: false, error: err };
      const tools = (res.response.result as { tools?: unknown } | undefined)?.tools;
      return {
        ok: true,
        tools: Array.isArray(tools)
          ? tools
              .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
              .map((t) => ({ name: String(t.name ?? ''), ...(typeof t.description === 'string' ? { description: t.description } : {}) }))
              .filter((t) => t.name.length > 0)
          : [],
      };
    }
    return { ok: false, error: `未知 transport：${row.transport}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

interface HttpRpcResult {
  response: JsonRpcResponse;
  sessionId: string | null;
}

async function httpRpc(
  url: string,
  payload: Record<string, unknown>,
  sessionId: string | null,
  timeoutMs: number,
): Promise<HttpRpcResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}：${text.slice(0, 300)}`);
    const contentType = res.headers.get('content-type') ?? '';
    let parsed: JsonRpcResponse;
    if (contentType.includes('text/event-stream')) {
      const dataLines = text
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .filter((line) => line.length > 0);
      const last = dataLines.reverse().find((line) => line.startsWith('{'));
      if (!last) throw new Error('MCP HTTP 返回 SSE 但无 JSON data');
      parsed = JSON.parse(last) as JsonRpcResponse;
    } else {
      parsed = JSON.parse(text) as JsonRpcResponse;
    }
    return { response: parsed, sessionId: res.headers.get('mcp-session-id') ?? sessionId };
  } finally {
    clearTimeout(timer);
  }
}

export async function callMcpTool(
  row: McpServerRow,
  tool: string,
  args: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<McpCallResult> {
  try {
    if (row.transport === 'stdio') {
      return await withStdio(row, timeoutMs, async (rpc) => {
        await handshake(rpc);
        const res = await rpc.request('tools/call', { name: tool, arguments: args });
        const err = rpcError(res);
        if (err) return { ok: false, error: err };
        const result = res.result as { content?: unknown } | undefined;
        return { ok: true, content: result?.content ?? result ?? null, raw: res.result };
      });
    }
    if (row.transport === 'http') {
      if (!row.url) return { ok: false, error: `http MCP 缺少 url：${row.name}` };
      // HTTP：initialize 取 session id → initialized → tools/call（同一短连）。
      const hs = await httpHandshake(row.url, timeoutMs);
      if (!hs.ok) return { ok: false, error: hs.error };
      const res = await httpRpc(
        row.url,
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } },
        hs.sessionId,
        timeoutMs,
      );
      const err = rpcError(res.response);
      if (err) return { ok: false, error: err };
      const result = res.response.result as { content?: unknown } | undefined;
      return { ok: true, content: result?.content ?? result ?? null, raw: res.response.result };
    }
    return { ok: false, error: `未知 transport：${row.transport}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
