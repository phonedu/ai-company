/**
 * IM 通道的类型面（本轮只做老板 ↔ 幕僚长 **1:1 私聊**，不建群对象）。
 *
 * 设计边界（PLAN §5/§14、D-13）：
 *  - IM 是传输管道，不是第二套项目/任务对象模型；项目靠消息里的 `#项目别名` 寻址。
 *  - 入站归一成 `core/resolver.ts` 的 `Inbound`，桌面与 IM 共用同一归属链。
 *  - 出站只送三类卡片（report/ask/alert）的文本降级；员工内部对话永不外发。
 */
export const IM_WECHAT = 'im:wechat' as const;
export type ImChannel = typeof IM_WECHAT;

/**
 * 连接状态：
 *  - disabled：用户解绑/未启用
 *  - login_required：有通道但没凭证，需要扫码
 *  - login_pending：二维码已出，等扫码
 *  - connecting：凭证有了，长轮询启动中
 *  - connected：长轮询在跑
 *  - error：最近一次错误（可继续轮询；详情在 lastError）
 */
export type ImConnectionState =
  | 'disabled'
  | 'login_required'
  | 'login_pending'
  | 'connecting'
  | 'connected'
  | 'error';

export interface ImStatus {
  channel: ImChannel;
  state: ImConnectionState;
  /** 二维码（data URL 或 URL）；仅 login_pending 有值。 */
  qr: string | null;
  qrStatus: string | null;
  /** 扫码登录者（唯一 boss 白名单）。 */
  ownerId: string | null;
  /** 机器人账号 id（iLink bot id）。 */
  accountId: string | null;
  lastError: string | null;
  /** 未发出/待补发的主动卡片数（真读数；不写假 0）。 */
  pendingOutbox: number;
}

/** 平台入站消息归一后的形状（文本-only；媒体在 adapter 层直接忽略并留痕）。 */
export interface ImInbound {
  channel: ImChannel;
  /** 私聊对端 id（iLink `from_user_id`）；也是 `im_conversations.conversation_ref`。 */
  conversationRef: string;
  senderId: string;
  senderName: string;
  text: string;
  platformMsgId: string | null;
  /** 引用回复的原消息 id（有则优先走回复链）。 */
  replyToMsgId: string | null;
  /** 回复凭据（iLink `context_token`）；只在本轮发送时使用，不落明文日志。 */
  replyContext?: string;
  receivedAt: number;
}

export interface ImSendTarget {
  conversationRef: string;
  replyContext?: string;
}

export interface ImSendResult {
  /** 平台侧消息 id（用于 outbound_refs 回复链；可能为空，此时靠序号兜底）。 */
  platformMsgId: string | null;
}

export interface ImAdapterCallbacks {
  onInbound(msg: ImInbound): void | Promise<void>;
  onState(state: ImConnectionState, detail?: string | null): void;
  onQr(qr: string, status: string): void;
}

/** 平台 adapter 接口；本轮只实现微信 iLink。 */
export interface ImAdapter {
  readonly channel: ImChannel;
  /** 已有凭证则连上；没有则回 login_required（不自动弹二维码）。 */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** 扫码登录（后台跑；二维码经 onQr 推送）。 */
  login(): Promise<void>;
  /** 平台要求数字验证码时提交（仅登录等待中有效）。 */
  submitVerifyCode?(code: string): void;
  /** 解绑：停轮询并清本地凭证。 */
  logout(): Promise<void>;
  sendText(target: ImSendTarget, text: string): Promise<ImSendResult>;
  /** 当前 owner（扫码登录者）；未登录为 null。 */
  getOwnerId(): string | null;
  getAccountId(): string | null;
}

/** 平台窗口/回复凭据失效：outbox 应置 blocked，等下次入站再补发。 */
export class ImWindowClosedError extends Error {
  readonly code = 'window_closed';
  constructor(message = '微信回复窗口已关闭（缺少或过期 context_token）') {
    super(message);
    this.name = 'ImWindowClosedError';
  }
}

/** 登录态失效：需要重新扫码。 */
export class ImAuthExpiredError extends Error {
  readonly code = 'auth_expired';
  constructor(message = '微信登录态已失效，请重新扫码') {
    super(message);
    this.name = 'ImAuthExpiredError';
  }
}

/** IPC 端口（`IpcDeps.im`）；设置页只用 status/bind/unbind。 */
export interface ImBindPort {
  status(): ImStatus;
  bind(input?: { verifyCode?: string }): Promise<ImStatus>;
  unbind(): Promise<ImStatus>;
}
