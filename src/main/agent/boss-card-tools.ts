/**
 * RW-51（2026-11-05 老板定性「必须做到」）：幕僚长的**待办卡工具**——
 * 老板在频道里用自然话（「把那张决策卡按推荐方案处理了」「待办都有什么」）
 * 就能驱动待办，而不必去点按钮。这是「一人公司」与「带按钮的表单」的分界线。
 *
 * 两张工具（只读 + 有副作用的成对设计）：
 *  - `boss_inbox`：列出全部待处理卡（含选项与推荐标记），只读；
 *  - `boss_card_resolve`：处理一张卡——`ack`（清除/已阅）或 `select`（按老板的话选选项）。
 *    select 走**既有审批真路径**（repo.answerApproval 联动 reports/grant + 引擎事件映射），
 *    不另造第二事实源。选项 key 不在卡面时明确报错并列出可选项（让幕僚长重试/追问）。
 */
import type { SqliteDb } from '../db/open.js';
import { acknowledgeReport as dbAcknowledgeReport } from '../db/reports.js';
import { answerApproval as dbAnswerApproval, isPermissionApproval } from '../db/approvals.js';
import { approvalAnswerEvent } from '../../core/approval-events.js';
import { applyApprovalAsGrant, isGrantingChoice } from '../permission/grants.js';
import type { EngineEvent } from '../engine/types.js';

export interface BossCardToolDeps {
  db: SqliteDb;
  /** 权限批准联动（与 recordCardIntent 同语义：批准→grant）。 */
  onGrant?: ((approvalId: number, chosen: string) => void) | null;
  /** 引擎（作答推状态机用；缺省＝只落台账不推，与 `task:approve` 无引擎时同口径）。 */
  engine?: { dispatch(event: EngineEvent): Promise<void> } | null;
  /** 待办读数变化（托盘/待办刷新）。 */
  onInboxChanged?: (() => void) | null;
  clock?: () => number;
}

interface CardRow {
  id: number;
  kind: string;
  state: string;
  task_id: number | null;
  payload: string;
}

function actionableCard(db: SqliteDb, cardId: number): CardRow | null {
  const row = db
    .prepare("SELECT id, kind, state, task_id, payload FROM reports WHERE id = ? AND state IN ('pending','delivered')")
    .get(cardId) as CardRow | undefined;
  return (row as CardRow | undefined) ?? null;
}

function cardTitleAndOptions(row: CardRow): { title: string; options: Array<{ key: string; recommended?: boolean }> } {
  try {
    const p = JSON.parse(row.payload) as { title?: string; tldr?: string; options?: Array<{ key: string; recommended?: boolean }> };
    return { title: p.title ?? p.tldr ?? '', options: Array.isArray(p.options) ? p.options : [] };
  } catch {
    return { title: '', options: [] };
  }
}

export async function createBossCardTools(deps: BossCardToolDeps): Promise<{ inboxTool: unknown; resolveTool: unknown }> {
  const [{ defineTool }, { Type }] = await Promise.all([
    import('@earendil-works/pi-coding-agent'),
    import('@earendil-works/pi-ai'),
  ]);
  const now = deps.clock ?? (() => Date.now());
  const notify = (): void => deps.onInboxChanged?.();

  const inboxTool = defineTool({
    name: 'boss_inbox',
    label: 'Boss Inbox',
    description:
      '只读列出老板「待我处理」的全部待办卡：卡 id / 类型 / 关联任务 / 题目 / 可选项（含推荐标记）。' +
      '老板问「待办有什么」「那张卡是什么」或你需要知道某张卡的可选项时先用本工具。本工具不改变任何数据。',
    parameters: Type.Object({}),
    async execute(_toolCallId: string, _params: object, _signal: AbortSignal | undefined, _onUpdate: undefined, _ctx: unknown) {
      const rows = deps.db
        .prepare("SELECT id, kind, state, task_id, payload FROM reports WHERE state IN ('pending','delivered') ORDER BY id DESC LIMIT 50")
        .all() as CardRow[];
      if (rows.length === 0) {
        return { content: [{ type: 'text', text: '待我处理当前没有待办卡。' }], details: { count: 0 } };
      }
      const lines = rows.map((row) => {
        const { title, options } = cardTitleAndOptions(row);
        const shortTask = row.task_id != null ? `T-${row.task_id}` : '—';
        const optText =
          options.length > 0
            ? ' 选项：' + options.map((o) => `${o.key}${o.recommended ? '（推荐）' : ''}`).join('/')
            : '';
        return `- 卡#${row.id} [${row.kind}] ${title || '（无题）'}（任务 ${shortTask}）${optText}`;
      });
      return { content: [{ type: 'text', text: `待办 ${rows.length} 张：\n${lines.join('\n')}` }], details: { count: rows.length } };
    },
  });

  const resolveTool = defineTool({
    name: 'boss_card_resolve',
    label: 'Boss Card Resolve',
    description:
      '处理一张待办卡（老板在对话里授权后调用）：action="ack"＝清除/已阅（通知类、已办完的卡）；' +
      'action="select"＝按老板的话给卡选一个选项（决策/批准卡，chosen 填卡面选项 key，如 approve/proceed 或具体方案 key）。' +
      '选项 key 不确定时先用 boss_inbox 查看卡面；选完把结果如实告诉老板。',
    parameters: Type.Object({
      card: Type.Number({ description: '待办卡 id（boss_inbox 里的 卡#N）' }),
      action: Type.String({ description: '动作类型：ack（清除/已阅）或 select（选选项）' }),
      chosen: Type.Optional(Type.String({ description: 'select 时要选的选项 key；ack 时忽略' })),
    }),
    async execute(_toolCallId: string, params: { chosen?: string; action: 'ack' | 'select'; card: number }, _signal: AbortSignal | undefined, _onUpdate: undefined, _ctx: unknown) {
      const card = actionableCard(deps.db, params.card);
      if (card == null) {
        return { content: [{ type: 'text', text: `卡#${params.card} 不存在或已处理（不重复处理）。` }], details: { action: params.action, card: params.card, result: 'not_found' } };
      }
      if (params.action === 'ack') {
        dbAcknowledgeReport(deps.db, card.id, now());
        notify();
        return { content: [{ type: 'text', text: `已清除卡#${card.id}（已阅）。` }], details: { action: 'ack', card: card.id, result: 'cleared' } };
      }
      // select：需要任务上的待批审批行；chosen 走既有审批真路径（联动 reports/grant）。
      if (card.task_id == null) {
        return { content: [{ type: 'text', text: `卡#${card.id} 不关联任务，只能 ack 清除，无法选选项。` }], details: { action: 'select', card: card.id, result: 'no_task' } };
      }
      const approval = deps.db
        .prepare('SELECT id, question FROM approvals WHERE task_id = ? AND chosen IS NULL ORDER BY id DESC LIMIT 1')
        .get(card.task_id) as { id: number; question: string | null } | undefined;
      if (approval == null) {
        return { content: [{ type: 'text', text: `任务 T-${card.task_id} 没有待批审批（可能已处理）。` }], details: { action: 'select', card: card.id, result: 'no_approval' } };
      }
      const { options } = cardTitleAndOptions(card);
      const chosen = (params.chosen ?? '').trim();
      if (chosen.length === 0) {
        const keys = options.map((o) => o.key).join('/');
        return { content: [{ type: 'text', text: `缺少 chosen。${keys.length > 0 ? `可选：${keys}` : '该卡接受自由回答（把老板的决定写进 chosen）。'}` }], details: { action: 'select', card: card.id, result: 'missing_chosen' } };
      }
      if (options.length > 0 && !options.some((o) => o.key === chosen)) {
        return {
          content: [
            { type: 'text', text: `选项「${chosen}」不在卡面上。可选：${options.map((o) => o.key).join('/')}。请与老板确认后再调用。` },
          ],
          details: { action: 'select', card: card.id, result: 'bad_choice' },
        };
      }
      // 走既有审批真路径（DAO 投影 reports resolved；grant 联动与 recordCardIntent 同语义）。
      dbAnswerApproval(deps.db, { approvalId: approval.id, chosen, decidedBy: 'boss', now: now() });
      if (isGrantingChoice(chosen)) {
        deps.onGrant?.(approval.id, chosen);
      }
      const task = deps.db.prepare('SELECT state FROM tasks WHERE id = ?').get(card.task_id) as { state: string } | undefined;
      // 换方向复核 P2-6（2026-11-09）：**权限审批不驱动任务状态机**（与 `task:approve` 同一口径）。
      // 此前幕僚长这个入口无条件映射，批准/拒绝一张权限卡会顺带推 decision_made/plan_approved。
      // 权限只影响 grant（`deps.onGrant` 已在上一步处理）；补跑本入口暂不接（如实不假装）。
      const permissionCard = isPermissionApproval(approval.question ?? '');
      const mapped = permissionCard ? null : approvalAnswerEvent(task?.state ?? null, chosen);
      if (mapped != null && deps.engine != null) {
        await deps.engine.dispatch({
          scope: 'task',
          id: card.task_id,
          event: mapped.event,
          actor: 'boss',
          payload: mapped.payload,
        });
      }
      notify();
      return { content: [{ type: 'text', text: `已处理卡#${card.id}：按「${chosen}」作答（任务 T-${card.task_id}${mapped ? `，已推 ${mapped.event}` : '，未推状态机'}）。` }], details: { action: 'select', card: card.id, result: 'resolved' } };
    },
  });

  return { inboxTool, resolveTool };
}
