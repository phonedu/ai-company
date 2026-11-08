/**
 * B3-1/D-31① · BYO 执行体——ACP（Agent Client Protocol）客户端 PoC。
 *
 * 口径（D-31①＋research-byo-executor §2）：
 *  - **单候选 opencode**（MIT＋原生 ACP；Claude 不碰 OAuth——合规红线）；
 *  - ACP ＝ JSON-RPC 2.0 over stdio；核心方法 `initialize` / `session/new` / `session/prompt` /
 *    `session/cancel` / `session/request_permission`；
 *  - **四验收**：①同一员工接口（submit_work_item 流程不变）②审批门外挂（request_permission
 *    → 我们的权限闸门）③成本落账（usage_update → costs 表）④会话恢复（session/load）；
 *  - PoC 范围：ACP client 基础设施（JSON-RPC stdio 子进程管理）＋员工接口适配层＋
 *    mock server 测试。**真 opencode 安装/联调随 B3b 真机批**。
 *
 * 不做：多候选适配器矩阵；Claude/Codex（JSON 兜底后置）；产品内候选市场。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

/** ACP JSON-RPC 2.0 消息（request/response/notification）。 */
export interface AcpMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** ACP 权限请求（审批门外挂的关键钩子）。 */
export interface AcpPermissionRequest {
  sessionId: string;
  toolCall: {
    title: string;
    kind: string;
    arguments?: Record<string, unknown>;
  };
  options: Array<{ kind: string; name?: string }>;
}

export interface AcpUsageUpdate {
  sessionId: string;
  tokensIn: number;
  tokensOut: number;
  costUsd?: number;
}

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export interface AcpClientOptions {
  /** agent 命令行（如 `opencode acp`）；无参 spawn。 */
  command: string;
  args?: string[];
  cwd?: string;
  /** 请求超时（ms；缺省 30s）。 */
  requestTimeoutMs?: number;
}

/**
 * ACP JSON-RPC over stdio 客户端。
 * 管理 agent 子进程生命周期；提供 request/notification 两类方法；
 * request_permission/usage_update 通过事件分发给调用方（审批门/成本落账的接线点）。
 */
export class AcpClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private buffer = '';

  constructor(private readonly options: AcpClientOptions) {
    super();
  }

  /** 启动 agent 子进程＋发 initialize 握手。 */
  async start(): Promise<void> {
    this.process = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    this.process.stdout!.on('data', (chunk: Buffer) => this.onData(chunk.toString()));
    this.process.stderr!.on('data', (chunk: Buffer) => {
      console.error('[acp] stderr:', chunk.toString().slice(0, 200));
    });
    this.process.on('exit', (code) => {
      this.emit('exit', code);
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('[acp] agent 进程退出'));
      }
      this.pending.clear();
    });
    await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { read: true, write: false } },
    });
  }

  /** 创建 ACP 会话。 */
  async sessionNew(cwd: string): Promise<string> {
    const result = (await this.request('session/new', { cwd })) as { sessionId: string };
    return result.sessionId;
  }

  /** 发 prompt（员工工作项的 brief）；返回 agent 回复文本。 */
  async sessionPrompt(sessionId: string, prompt: string): Promise<string> {
    const result = (await this.request('session/prompt', { sessionId, prompt })) as {
      stopReason: string;
      message?: { content?: Array<{ type: string; text?: string }> };
    };
    const text = result.message?.content?.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('') ?? '';
    return text;
  }

  /** 取消会话。 */
  async sessionCancel(sessionId: string): Promise<void> {
    await this.notify('session/cancel', { sessionId });
  }

  /** 回复权限请求（审批门外挂：allow/deny 由我们的 permissionGate 决定）。 */
  async respondPermission(requestId: number, outcome: { outcome: string; optionId?: string }): Promise<void> {
    await this.notify('session/respond_permission', { id: requestId, ...outcome });
  }

  /** JSON-RPC request（发＋等响应）。 */
  private request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const timeoutMs = this.options.requestTimeoutMs ?? 30_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`[acp] ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** JSON-RPC notification（发不等待）。 */
  private async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    this.send({ jsonrpc: '2.0', method, params });
  }

  private send(msg: AcpMessage): void {
    if (!this.process?.stdin) {
      // B3-1 PoC：无真子进程时静默（测试通过 feedStdout 注入响应）；生产必须有 process。
      return;
    }
    const line = JSON.stringify(msg) + '\n';
    this.process.stdin.write(line);
  }

  /** 解析 stdout 数据（按行切 JSON-RPC 消息）。 */
  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length === 0) continue;
      try {
        const msg = JSON.parse(line) as AcpMessage;
        this.onMessage(msg);
      } catch {
        console.error('[acp] 非 JSON 行:', line.slice(0, 100));
      }
    }
  }

  private onMessage(msg: AcpMessage): void {
    // 响应（有 id 且有 result/error）
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const id = typeof msg.id === 'string' ? Number(msg.id) : msg.id;
      const pending = this.pending.get(id!);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id!);
        if (msg.error) pending.reject(new Error(`[acp] ${msg.error.message}`));
        else pending.resolve(msg.result);
      }
      return;
    }
    // 服务端请求（session/request_permission）
    if (msg.method === 'session/request_permission' && msg.id != null) {
      this.emit('permission_request', { requestId: msg.id, params: msg.params as unknown as AcpPermissionRequest });
      return;
    }
    // 服务端通知（usage_update 等）
    if (msg.method === 'usage_update') {
      this.emit('usage_update', msg.params as unknown as AcpUsageUpdate);
      return;
    }
    // session/update（agent 流式输出）
    if (msg.method === 'session/update') {
      this.emit('session_update', msg.params);
      return;
    }
    this.emit('message', msg);
  }

  /** 停止 agent 子进程。 */
  stop(): void {
    this.process?.kill();
    this.process = null;
  }

  /** B3-1 PoC 测试辅助：直接喂 stdout 数据（不走真子进程）。 */
  feedStdout(data: string): void {
    this.onData(data);
  }

  /** 覆写 send（测试注入；缺省写 process.stdin）。 */
  overrideSend(fn: (msg: AcpMessage) => void): void {
    (this as unknown as { send: (msg: AcpMessage) => void }).send = fn;
  }
}
