/** IM 通道公共出口（本轮：微信 1:1）。 */
export {
  IM_WECHAT,
  ImAuthExpiredError,
  ImWindowClosedError,
  type ImAdapter,
  type ImAdapterCallbacks,
  type ImBindPort,
  type ImChannel,
  type ImConnectionState,
  type ImInbound,
  type ImSendResult,
  type ImSendTarget,
  type ImStatus,
} from './types.js';
export {
  createFileCredentialStore,
  createMemoryCredentialStore,
  type ImCredentialStore,
  type ImStoredState,
  type SafeStorageLike,
  type WeChatCredentials,
} from './store.js';
export {
  WeChatIlinkAdapter,
  type WeChatClientFactory,
  type WeChatSdkClient,
  type WeChatSdkClientOptions,
  type WeChatSdkLoginOptions,
  type WeChatSdkLoginResult,
  type WeChatSdkMessage,
  type WeChatSdkStartOptions,
} from './wechat.js';
export { createOfficialWechatClient, OfficialWechatClient, parseWeixinApiJson } from './wechat-official.js';
export { ImOutbox } from './outbox.js';
export { ImManager, type ImInboundHandler, type ImManagerOptions } from './manager.js';
export { handleImInbound, toCoreInbound } from './bridge.js';
export { formatCardText, chunkText } from './format.js';
export {
  findPendingApprovalForInbound,
  handleImApprovalReply,
  parseApprovalChoice,
  type ApprovalReplyResult,
  type PendingApprovalForReply,
} from './approval.js';
