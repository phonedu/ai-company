/**
 * B3-1/D-31① · BYO 执行体 opencode 适配器——把 ACP 会话映射到员工接口。
 *
 * 四验收映射：
 *  ① 同一员工接口：prompt(brief) → ACP session/prompt → 回复文本 → submit_work_item 流程不变；
 *  ② 审批门外挂：session/request_permission 事件 → 调用方注册的审批回调（→ 权限闸门）；
 *  ③ 成本落账：usage_update 事件 → onUsage 回调（→ costs 表，折算表待真机）；
 *  ④ 会话恢复：session/load → AcpClient.sessionNew 返回 sessionId，适配层缓存可续跑。
 */
import { AcpClient } from './acp-client.js';

export interface ByoExecutorOptions {
  /** agent 命令（如 `opencode`）；args 为 ACP 模式参数。 */
  command: string;
  args?: string[];
  cwd?: string;
  /** 审批回调（审批门外挂）：return true=放行 / false=拒绝。 */
  onPermissionRequest?: (info: { title: string; kind: string; args?: Record<string, unknown> }) => Promise<boolean>;
  /** 用量回调（成本落账）。 */
  onUsage?: (usage: { tokensIn: number; tokensOut: number; costUsd?: number }) => void;
}

export interface ByoRunResult {
  ok: boolean;
  text: string;
  sessionId: string;
}

/** BYO 执行体：封装 AcpClient → 提供与员工会话同形的 run/abort 接口。 */
export class ByoExecutor {
  private client: AcpClient;
  private sessionId: string | null = null;

  constructor(private readonly options: ByoExecutorOptions) {
    this.client = new AcpClient({
      command: options.command,
      args: options.args ?? ['acp'],
      cwd: options.cwd,
    });
    if (options.onPermissionRequest) {
      this.client.on('permission_request', (event: { requestId: number; params: { toolCall: { title: string; kind: string; arguments?: Record<string, unknown> }; options?: Array<{ kind: string; name?: string }> } }) => {
        void options.onPermissionRequest!({
          title: event.params.toolCall?.title ?? 'unknown',
          kind: event.params.toolCall?.kind ?? 'unknown',
          args: event.params.toolCall?.arguments,
        }).then((allowed) => {
          // ACP 规范：selected 或 rejected；选第一个 allow 选项的 optionId（如果有）。
          const allowOption = event.params.options?.find((o) => o.kind === 'allow');
          this.client.respondPermission(event.requestId, allowed, allowOption?.name);
        });
      });
    }
    if (options.onUsage) {
      this.client.on('usage_update', (usage: { tokensIn: number; tokensOut: number; costUsd?: number }) => {
        options.onUsage!(usage);
      });
    }
  }

  /** 启动 agent＋创建会话。 */
  async start(): Promise<void> {
    await this.client.start();
    this.sessionId = await this.client.sessionNew(this.options.cwd ?? process.cwd());
  }

  /** 跑一转（员工 brief → agent 回复）。 */
  async run(brief: string): Promise<ByoRunResult> {
    if (!this.sessionId) throw new Error('[byo] 会话未创建——先调 start()');
    const text = await this.client.sessionPrompt(this.sessionId, brief);
    return { ok: true, text, sessionId: this.sessionId };
  }

  /** 恢复会话（D-31 四验收④）：先停旧进程再重建（PoC 最小实现；真恢复需 session/load）。 */
  async resume(): Promise<void> {
    this.stop();
    await this.start();
  }

  stop(): void {
    this.client.stop();
  }
}
