/**
 * IM → 桌面共用入站链路的桥。
 *
 * 顺序：
 *  ① 先试「拍板回复」（引用卡片/回 1/2）——命中即作答，绝不把「1」当新任务；
 *  ② 否则先回执「收到」，再走共享 `handleInboundChat`（项目别名归位 → 建任务 → 幕僚长）；
 *  ③ 幕僚长这一轮没有回复时给明确文案，不静默。
 */
import { handleInboundChat, isDirectCommandText, type IpcDeps } from '../ipc/ipc.js';
import type { Inbound } from '../../core/resolver.js';
import { handleImApprovalReply } from './approval.js';
import type { ImInbound } from './types.js';

export function toCoreInbound(msg: ImInbound): Inbound {
  return {
    source: msg.channel,
    conversationRef: msg.conversationRef,
    platformMsgId: msg.platformMsgId,
    replyToMsgId: msg.replyToMsgId,
    text: msg.text,
    receivedAt: msg.receivedAt,
  };
}

export interface ImInboundResult {
  reply: string | null;
}

/**
 * `sendAck` 由 manager 注入（走同一 adapter）；回执失败只留日志，不打断主处理。
 */
export async function handleImInbound(
  deps: IpcDeps,
  msg: ImInbound,
  at: number,
  sendAck?: (text: string) => Promise<void>,
): Promise<ImInboundResult> {
  const approval = await handleImApprovalReply(deps, msg, at);
  if (approval.handled) {
    // 手机拍板也是老板说的话：落进老板频道同一任务线程（此前只作答不上屏，
    // 桌面偶发看不到手机回的 1/2）。同时落系统的确认回执，保证两端口径一致。
    deps.repo.insertMessage({
      direction: 'in',
      taskId: approval.taskId ?? null,
      content: msg.text,
      attachments: [],
      now: at,
    });
    if (approval.reply && approval.reply.trim().length > 0) {
      deps.repo.insertMessage({
        direction: 'out',
        taskId: approval.taskId ?? null,
        attachments: [],
        content: approval.reply,
        now: at,
      });
    }
    deps.onInboxChanged?.();
    return { reply: approval.reply ?? null };
  }

  // 命令/建任务有即时回执，不再先发“收到，已交给幕僚长”（否则会先误导再补一条真回执）。
  const likelyNewTask = /^\s*#[^\s#]+/.test(msg.text);
  if (sendAck && !isDirectCommandText(msg.text) && !likelyNewTask) {
    try {
      await sendAck('收到，已交给幕僚长。');
    } catch (error) {
      console.warn('[im] 回执发送失败（继续处理）', error);
    }
  }

  const result = await handleInboundChat(deps, toCoreInbound(msg), at, [], { awaitAssistant: true });
  if (result.reply && result.reply.trim().length > 0) {
    return { reply: result.reply };
  }
  if (!deps.assistant) {
    return { reply: '幕僚长暂不可用（缺 key / 模型未就绪）；你的消息已记录。' };
  }
  return { reply: '幕僚长这一轮没有返回内容；你的消息已记录，请稍后重试或看桌面日志。' };
}
