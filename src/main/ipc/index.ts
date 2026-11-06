import type { IpcMain } from 'electron';

import { registerAppIpc, type IpcDeps } from './ipc.js';
import { registerFileImportIpc } from './file-import.js';

export {
  handleChatSend,
  handleChatList,
  handleInboxList,
  handleInboxAnswer,
  handleTaskApprove,
  handleTaskCreate,
  handleTaskList,
  handleTaskGet,
  handleTaskTransition,
  handleCardAction,
  defaultClassify,
} from './ipc.js';
export type { IpcDeps, AssistantPort, TaskDetailDTO, AcceptanceItemDTO } from './ipc.js';
export { createSqliteChatRepo } from './repo.js';
export { seedDemoData } from './demo.js';
export type {
  ChatRepo,
  StoredMessage,
  StoredReport,
  StoredApproval,
  StoredTask,
  StoredTaskDetail,
  StoredPlanStep,
  StoredTaskEvent,
  AttachmentMeta,
} from './ports.js';

/** 注册全部 IPC 通道（域集合见 DEV §7.3）。 */
export function registerAllIpc(ipcMain: IpcMain, deps: IpcDeps): void {
  registerAppIpc(ipcMain, deps);
  registerFileImportIpc(ipcMain); // D1 例外③：preload 可信路径 / 字节通路
}
