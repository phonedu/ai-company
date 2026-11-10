/**
 *  · 通知执行器（`src/main/notify/**`）。
 *
 * 目的：员工产出 / 系统事件 → **通知到人**（可见、不重复、不泄密）。
 * 范围（2894/2918，一字不加）：**通知 → `inbox:list()` 可见 + `dedupe_key` 去重 + 载荷脱敏**。
 * **不含**系统通知/托盘/角标（= `OPT-EXT-1b`）。
 *
 * 数据模型（接手时的事实核对；见报告设计记录与本文件注释）：
 *  - `notifications` 表**无 payload/kind 列**（只有 report_id/channel/dedupe_key…）= **投递清单**；
 *  - **载荷与 kind 落在 `reports`**（`kind/payload/dedupe_key`），而 **`inbox:list()` 正是列 `reports`**
 *    （`ipc.ts#handleInboxList` → `listReports`）。
 *  ⇒ 因此 `notify()` = **写一条 `reports`（可见内容）+ 写一条 `notifications`（幂等投递清单）**；
 *    二者都复用**既有 DAO**（`insertReport` / `insertNotification`，**不复制 DAO**）。
 *
 * 去重：`notify` **先查 `notifications.dedupe_key`** → 命中**整体短路**（不写 report、不写清单）；
 *  未命中才写。DB 侧 `notifications.dedupe_key` 有 `UNIQUE` 兜底（并发下第二写被 `INSERT OR IGNORE` 丢弃）。
 */
import type { SqliteDb } from '../db/open.js';
import { getNotificationByDedupeKey, insertNotification } from '../db/notifications.js';
import { insertReport } from '../db/reports.js';
import { readSetting } from '../db/settings.js';
import { deliveryChannel, isQuietAt, minuteOfDay, type QuietWindow } from './policy.js';
import { redactPayload } from './redact.js';

/** 通知（= 一条 `reports` 行）的缺省 kind（与 `report`/`ask`/`alert` 并列，便于 UI 区分来源）。 */
export const NOTIFICATION_KIND = 'notification';

export interface NotifyInput {
  /** 承载该通知的任务 id；`null` = **全局卡**（不属任何任务，如空库首启日报；`reports.task_id` 迁移 008 起可空）。 */
  taskId: number | null;
  /** 幂等键：同键重复投递**不叠加**。 */
  dedupeKey: string;
  /** 通知载荷（任意 JSON）——**入库前一律脱敏**（密钥/令牌/绝对用户路径 → 占位）。 */
  payload: unknown;
  /** `reports.kind`，缺省 `'notification'`。 */
  kind?: string;
  /** 投递通道（`notifications.channel`），缺省 `'desktop'`（**静默期内非紧急会改走 `'digest'`**，见 `policy.ts`）。 */
  channel?: string;
  /**  余：紧急（如员工被卡住的升级）——**静默期内照常推**。 */
  urgent?: boolean;
  conversationRef?: string | null;
  now?: number;
}

export interface NotifyResult {
  /** `false` = 该 `dedupeKey` 已投递过（本次短路，未新增任何行）。 */
  delivered: boolean;
  reportId: number | null;
}

/** OPT-EXT-1b：投递成功后的旁路钩子（main 注入：系统通知 / 托盘未读刷新）。缺省 null＝不做事。 */
export interface NotifyDelivery {
  reportId: number | null;
  /** 承载任务；`null` = 全局卡（桌面通知点击后回老板频道）。 */
  taskId: number | null;
  dedupeKey: string;
  channel: string;
  payload: unknown;
  urgent: boolean;
  now: number;
}

let deliveryHook: ((delivery: NotifyDelivery) => void) | null = null;

/** 注入投递旁路（只影响"通知到人"的展示层；不改库/去重语义）。 */
export function setNotifyDeliveryHook(hook: ((delivery: NotifyDelivery) => void) | null): void {
  deliveryHook = hook;
}

/**
 * 投递一条通知。**幂等**（同 `dedupeKey` 只生效一次）、**载荷脱敏**（入库前）。
 * 返回 `{delivered, reportId}`（短路时 `reportId` = 既有清单指向的 report）。
 */
export function notify(db: SqliteDb, input: NotifyInput): NotifyResult {
  const existing = getNotificationByDedupeKey(db, input.dedupeKey);
  if (existing) return { delivered: false, reportId: existing.report_id };

  const now = input.now ?? Date.now();
  const safePayload = redactPayload(input.payload);
  const report = insertReport(db, {
    taskId: input.taskId,
    kind: input.kind ?? NOTIFICATION_KIND,
    payload: safePayload,
    dedupeKey: input.dedupeKey,
    now,
  });
  //  余（`` 静默时段）：默认 desktop 通道在静默期内、非紧急 → 改走 `digest`（夜里不弹、日报里见）。
  // **投递行照写**（dedupe_key 是幂等清单，跳过会丢件）——只改 channel 语义。调用方显式给 channel 时不干预。
  const quiet = readQuietWindow(db);
  const channel =
    input.channel ??
    deliveryChannel(isQuietAt(minuteOfDay(now), quiet), input.urgent === true);
  insertNotification(db, {
    reportId: report.id,
    channel,
    conversationRef: input.conversationRef ?? null,
    dedupeKey: input.dedupeKey,
    sentAt: now,
  });
  // OPT-EXT-1b：投递成功后旁路（系统通知/托盘）；**不改**库与去重语义。钩子自身异常不得打断投递。
  if (deliveryHook) {
    try {
      deliveryHook({
        reportId: report.id,
        taskId: input.taskId,
        dedupeKey: input.dedupeKey,
        channel,
        payload: safePayload,
        urgent: input.urgent === true,
        now,
      });
    } catch (error) {
      console.error('[notify] 投递旁路失败（通知已落库，不静默）', error);
    }
  }
  return { delivered: true, reportId: report.id };
}

/** 读静默窗配置（`notify.quietStartMinutes`/`notify.quietEndMinutes`；未设/非法 → null ＝ 不静默）。 */
function readQuietWindow(db: SqliteDb): QuietWindow | null {
  const start = readSetting(db, 'notify.quietStartMinutes');
  const end = readSetting(db, 'notify.quietEndMinutes');
  if (typeof start !== 'number' || typeof end !== 'number') return null;
  return { startMinutes: start, endMinutes: end };
}
