import { useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { useSnapshot } from 'valtio';

import { acknowledgeCard, answerCard, cardIntent, openTaskDetail, readArtifact, schemas } from '../store.js';
import type { ReportDTO } from '../types.js';
import { CardPlan } from './CardPlan.js';
import { CardTaskSections } from './CardTaskSections.js';
import { CARD_KIND_META, CARD_STATE_TEXT, formatCardClock, isActionable, remainText, verdictText, verdictTone } from './cardCopy.js';
import { customAnswerAllowed, isMultiSelect, multiChosen, permissionDetailLines } from './cardAnswer.js';
import { digestLine } from './inboxModel.js';
import { ControlledRenderer } from './genui/ControlledRenderer.js';
import { validateSchema, type GenUiSchema } from './genui/schema.js';
import { ProseText } from './ProseText.js';

// 卡片：受理(report)/决策(ask)/汇报(report)/异常(alert)。`kind` 定版式、`state` 定可操作性。
// UI §4.1：同一张待处理卡片在老板频道可原地点按钮，点完即消（state 变 resolved）。
// M1（`UI §4.7`）：卡片可携带 `payload.schema`（GenUI）→ 由**受控渲染器**渲染（同 kind、换 renderer）；
//   schema 非法/未知组件 → **整卡降级 legacy 文本**（不白屏）；无 schema → 走原 legacy 渲染（M0 行为不变）。
// 2026-10-16（频道批，设计板 v4）：kind＝**语义色点**（不再 emoji）；state＝**人话 chip**；
//   ask 卡＝倒计时（`payload.timeoutAt`）＋超时默认注（`payload.defaultAction`）＋选项**键帽**；
//   report 卡＝「去验收」→ 任务详情。文案/读数口径在 `cardCopy.ts`（可单测）。

/** legacy 兜底文本（非法/缺失 schema 时用；纯文本、不渲染任何模型 HTML）。 */
function fallbackText(card: ReportDTO): string {
  return card.payload.title ?? card.payload.question ?? card.payload.tldr ?? card.payload.summary ?? '（卡片内容不可用）';
}

function CardShell({
  card,
  collapsed,
  onToggle,
  children,
}: {
  card: ReportDTO;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}): ReactElement {
  const meta = CARD_KIND_META[card.kind] ?? { tone: 'dim', label: '卡片' };
  const actionable = isActionable(card.state);
  const due = typeof card.payload.timeoutAt === 'number' ? card.payload.timeoutAt : null;
  const createdTitle = Number.isFinite(card.createdAt) && card.createdAt > 0
    ? new Date(card.createdAt).toLocaleString('zh-CN')
    : '时间未知';
  return (
    <article
      className="card"
      data-testid="card"
      data-card-id={card.id}
      data-kind={card.kind}
      data-state={card.state}
      data-collapsed={collapsed ? 'true' : 'false'}
    >
      <header className="card__head">
        <span className="card__dot" data-tone={meta.tone} aria-hidden="true" />
        <span className="card__label">{meta.label}</span>
        {card.shortId ? <span className="card__short">{card.shortId}</span> : null}
        {/* ask 卡在待办期以**倒计时**占右上（超时真读数）；否则 state 人话 chip。 */}
        {card.kind === 'ask' && actionable && due != null ? (
          <span className="card__due" data-testid="card-due">
            {remainText(due, Date.now())}
          </span>
        ) : (
          <span className="card__state" data-testid="card-state">
            {CARD_STATE_TEXT[card.state] ?? card.state}
          </span>
        )}
        {/* 老板 2026-10-24：无头像的卡片也要显示出现时间（悬停看完整日期）。 */}
        <span
          className="card__time"
          data-testid="card-time"
          data-created-at={Number.isFinite(card.createdAt) ? card.createdAt : ''}
          title={createdTitle}
        >
          {formatCardClock(card.createdAt)}
        </span>
        <button
          type="button"
          className="card__collapse"
          data-testid="card-collapse"
          aria-expanded={!collapsed}
          aria-label={collapsed ? '展开卡片' : '折叠卡片'}
          title={collapsed ? '展开卡片' : '折叠卡片'}
          onClick={onToggle}
        >
          {collapsed ? '▸' : '▾'}
        </button>
      </header>
      {collapsed ? null : (
        <div className="card__body" data-testid="card-body">
          {children}
        </div>
      )}
    </article>
  );
}

export function Card({ card, initialCollapsed = false }: { card: ReportDTO; initialCollapsed?: boolean }): ReactElement {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const toggleCollapsed = (): void => setCollapsed((value) => !value);
  const schemasSnap = useSnapshot(schemas);
  const payloadSchemaId =
    card.payload.schema && typeof card.payload.schema === 'object'
      ? (card.payload.schema as { id?: unknown }).id
      : undefined;

  // 优先取「被 patch 更新过」的 store 版本；否则校验 payload 里的原始 schema。
  const patched: GenUiSchema | undefined =
    typeof payloadSchemaId === 'string' ? (schemasSnap.byId[payloadSchemaId] as GenUiSchema | undefined) : undefined;

  if (patched) {
    return (
      <CardShell card={card} collapsed={collapsed} onToggle={toggleCollapsed}>
        <ControlledRenderer
          schema={patched}
          onIntent={(intent) => {
            void cardIntent(intent, card);
          }}
        />
      </CardShell>
    );
  }

  if (card.payload.schema !== undefined) {
    const validated = validateSchema(card.payload.schema);
    if (validated.ok) {
      return (
        <CardShell card={card} collapsed={collapsed} onToggle={toggleCollapsed}>
          <ControlledRenderer
            schema={validated.schema}
            onIntent={(intent) => {
              void cardIntent(intent, card);
            }}
          />
        </CardShell>
      );
    }
    // 非法 / 未知组件 / M4 组件 → **整卡降级 legacy 文本**（AC1：不白屏）
    return (
      <CardShell card={card} collapsed={collapsed} onToggle={toggleCollapsed}>
        <ProseText className="card__fallback" testId="genui-fallback" text={fallbackText(card)} />
      </CardShell>
    );
  }

  // ── 以下为 M0 legacy 渲染（无 schema 时，行为与之前一致）──────────────────
  const actionable = isActionable(card.state);
  // RW-21：选项源兜底——payload.options 优先；历史升级卡 payload 无 options 时用审批行的
  // approvalOptions（同一行也供 approvalId，作答通路不变）。
  const payloadOptions = (card.payload.options ?? []) as Array<{ key: string; label?: string; recommended?: boolean }>;
  const cardOptions: Array<{ key: string; label?: string; recommended?: boolean }> =
    payloadOptions.length > 0 ? payloadOptions : (card.approvalOptions ?? []).map((o) => ({ ...o }));
  // 多选＋自定义作答（老板 2026-10-28 指令）：multi＝勾选后统一提交（chosen=k1+k2）；
  // 自定义＝选项都不满意时手写作答（chosen=原文）——仅决策/普通 ask（机器键卡不给）。
  const multi = isMultiSelect(card.payload);
  const allowCustom = actionable && customAnswerAllowed({ kind: card.kind, payload: card.payload });
  const [picked, setPicked] = useState<string[]>([]);
  const [customOpen, setCustomOpen] = useState(false);
  const [customText, setCustomText] = useState('');
  // P0/V1（S13-E 对抗审查）：作答期间禁用按钮、失败就地显示——不得静默消失或重复提交。
  const [answerPending, setAnswerPending] = useState(false);
  const [answerError, setAnswerError] = useState<string | null>(null);
  const submitAnswer = async (chosen: string): Promise<boolean> => {
    setAnswerPending(true);
    setAnswerError(null);
    const result = await answerCard(card, chosen);
    if (!result.ok) setAnswerError(result.error ?? '作答失败');
    setAnswerPending(false);
    return result.ok;
  };
  const submitAck = async (): Promise<void> => {
    setAnswerPending(true);
    setAnswerError(null);
    const result = await acknowledgeCard(card);
    if (!result.ok) setAnswerError(result.error ?? '操作失败');
    setAnswerPending(false);
  };
  const due = typeof card.payload.timeoutAt === 'number' ? card.payload.timeoutAt : null;
  const defaultAction = typeof card.payload.defaultAction === 'string' ? card.payload.defaultAction : null;
  const digest = card.kind === 'notification' ? digestLine(card.payload.digest) : null;
  // 卡片可读性批（老板 2026-10-28）：权限卡优先结构化三行（谁/干什么/哪个项目），
  // 原始技术串与 session 收进折叠；老卡（无 detail）回落 question 原样。
  const permDetail = permissionDetailLines(card.payload);

  return (
    <CardShell card={card} collapsed={collapsed} onToggle={toggleCollapsed}>

      {card.payload.title ? <div className="card__title">{card.payload.title}</div> : null}
      {permDetail != null ? (
        <div className="card__question card__permission" data-testid="card-permission-detail">
          <div>
            <strong>{permDetail.who}</strong> 申请：{permDetail.action}
          </div>
          <div>项目：{permDetail.project}</div>
          <details className="card__permission-raw">
            <summary>技术细节</summary>
            {permDetail.session ? <div>会话：{permDetail.session}</div> : null}
            {card.payload.question ? <div>{card.payload.question}</div> : null}
          </details>
        </div>
      ) : card.payload.question &&
      !(card.kind === 'ask' && card.payload.question === `需要你决策（${card.shortId ?? `#${card.taskId}`}）`) ? (
        <div className="card__question">{card.payload.question}</div>
      ) : null}
      {/* D-22：Key/模型硬拒的决策卡要直接在卡面说清原因（不只藏在 payload/时间线）。 */}
      {typeof card.payload.modelRejected === 'string' && card.payload.modelRejected.trim().length > 0 ? (
        <ProseText className="card__notes" testId="card-model-rejected" text={card.payload.modelRejected} />
      ) : null}
      {card.payload.tldr ? <ProseText className="card__tldr" text={card.payload.tldr} /> : null}
      {card.payload.summary ? <ProseText className="card__summary" text={card.payload.summary} /> : null}
      {/* E-16：卡正文（招募卡的人设/模型/技能等）——此前 body 无任何渲染面，内容是死数据。 */}
      {card.payload.body ? <ProseText className="card__bodytext" testId="card-body-text" text={card.payload.body} /> : null}
      {/* GAP12：评审/验证结论 + 文字批注（reports.verdict 真列优先，payload 兜底）。 */}
      {verdictText(card.verdict ?? card.payload.verdict) != null ? (
        <span
          className="card__verdict"
          data-testid="card-verdict"
          data-tone={verdictTone(card.verdict ?? card.payload.verdict)}
          data-verdict={card.verdict ?? card.payload.verdict ?? ''}
        >
          结论：{verdictText(card.verdict ?? card.payload.verdict)}
        </span>
      ) : null}
      {typeof card.payload.notes === 'string' && card.payload.notes.trim().length > 0 ? (
        <ProseText className="card__notes" testId="card-notes" text={card.payload.notes} />
      ) : null}
      {/* GAP8：批准卡直接展示计划全文；编辑计划后由主进程合并更新 payload（卡与详情同步）。
          2026-11-06（F-02 真机抓到的真崩溃）：`planSteps` 必须是**数组**才渲染——历史/外部
          payload 若混进同名字符串，CardPlan 会 .map 崩掉并让 React 整棵卸载（空页）。 */}
      {Array.isArray(card.payload.planSteps) && card.payload.planSteps.length > 0 ? (
        <CardPlan steps={card.payload.planSteps} />
      ) : null}
      {digest ? (
        <p className="card__digest" data-testid="card-digest">
          {digest}
        </p>
      ) : null}
      {card.kind === 'report' && card.taskId != null ? (
        <CardTaskSections
          taskId={card.taskId}
          onPreviewArtifact={(artifactId) => {
            if (card.taskId == null) return;
            void openTaskDetail(card.taskId);
            void readArtifact(artifactId);
          }}
        />
      ) : null}

      {/* RW-21：选项源＝卡 payload 优先，缺/空时兜底审批行的 options（历史升级卡复活按钮）。 */}
      {cardOptions.length > 0 ? (
        <div className="card__options" data-multi={multi ? 'true' : 'false'}>
          {cardOptions.map((option) =>
            multi ? (
              // 多选：勾选 toggle，统一「提交」作答（老板 2026-10-28 指令——AI 列多项可同时选）。
              <button
                key={option.key}
                type="button"
                className={`card__btn${picked.includes(option.key) ? ' card__btn--picked' : ''}`}
                data-testid="card-option"
                data-option={option.key}
                data-picked={picked.includes(option.key) ? 'true' : 'false'}
                disabled={!actionable || answerPending}
                aria-pressed={picked.includes(option.key)}
                onClick={() => {
                  setPicked((prev) =>
                    prev.includes(option.key) ? prev.filter((k) => k !== option.key) : [...prev, option.key],
                  );
                }}
              >
                <span className="card__tick" aria-hidden="true">
                  {picked.includes(option.key) ? '☑' : '☐'}
                </span>{' '}
                {option.label}
              </button>
            ) : (
              <button
                key={option.key}
                type="button"
                className={`card__btn${option.recommended ? ' card__btn--primary' : ''}`}
                data-testid="card-option"
                data-option={option.key}
                disabled={!actionable || answerPending}
                onClick={() => {
                  void submitAnswer(option.key);
                }}
              >
                {option.label}
                {option.recommended && !(option.label ?? '').includes('（推荐）') ? '（推荐）' : ''}
              </button>
            ),
          )}
          {multi ? (
            <button
              type="button"
              className="card__btn card__btn--primary"
              data-testid="card-multi-submit"
              disabled={!actionable || answerPending || picked.length === 0}
              onClick={() => {
                void submitAnswer(multiChosen(picked)).then((ok) => { if (ok) setPicked([]); });
              }}
            >
              提交（已选 {picked.length} 项）
            </button>
          ) : null}
          {card.kind === 'ask' && card.taskId != null ? (
            <button
              type="button"
              className="card__btn card__btn--ghost"
              data-testid="card-goto-task-ask-inline"
              onClick={() => {
                void openTaskDetail(card.taskId as number);
              }}
            >
              去任务详情
            </button>
          ) : null}
        </div>
      ) : null}

      {/* 自定义作答（老板 2026-10-28 指令）：列出的选项都不满意时自己写；机器键卡（批准/权限）不给。 */}
      {allowCustom && cardOptions.length > 0 ? (
        customOpen ? (
          <div className="card__custom" data-testid="card-custom">
            <textarea
              data-testid="card-custom-text"
              rows={2}
              placeholder="写下你的决定（会原文记入台账并推进任务）"
              value={customText}
              onChange={(e) => setCustomText((e.target as HTMLTextAreaElement).value)}
            />
            <div className="card__custom-actions">
              <button
                type="button"
                data-testid="card-custom-submit"
                disabled={customText.trim().length === 0 || answerPending}
                onClick={() => {
                  void submitAnswer(customText.trim()).then((ok) => {
                    if (ok) { setCustomOpen(false); setCustomText(''); }
                  });
                }}
              >
                提交自定义作答
              </button>
              <button
                type="button"
                data-testid="card-custom-cancel"
                onClick={() => {
                  setCustomOpen(false);
                  setCustomText('');
                }}
              >
                收起
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="card__btn card__btn--ghost"
            data-testid="card-custom-toggle"
            onClick={() => setCustomOpen(true)}
          >
            都不合适？自定义作答…
          </button>
        )
      ) : null}

      {answerError != null ? (
        <p className="card__answer-error" data-testid="card-answer-error" role="alert">
          作答失败：{answerError}
        </p>
      ) : null}

      {/* 超时默认动作注（`defaultAction` 真读数）：到点会发生什么，先说清。 */}
      {actionable && due != null && defaultAction != null ? (
        <p className="card__timeout" data-testid="card-timeout">
          {remainText(due, Date.now()) === '已到点'
            ? `已到点 → 默认按 ${defaultAction} 执行`
            : `${remainText(due, Date.now())}后未回复 → 默认按 ${defaultAction} 执行`}
        </p>
      ) : null}

      {actionable && card.kind === 'report' && card.taskId != null ? (
        <div className="card__actions">
          <button
            type="button"
            className="card__btn card__btn--primary"
            data-testid="card-goto-task"
            onClick={() => {
              void openTaskDetail(card.taskId as number);
            }}
          >
            去验收
          </button>
          <button
            type="button"
            className="card__btn card__btn--ghost"
            data-testid="card-ack"
            disabled={answerPending}
            onClick={() => {
              void submitAck();
            }}
          >
            标记已阅
          </button>
        </div>
      ) : actionable && card.kind === 'ask' && card.taskId != null && (card.payload.options?.length ?? 0) === 0 ? (
        <div className="card__actions">
          <button
            type="button"
            className="card__btn card__btn--primary"
            data-testid="card-goto-task-ask"
            onClick={() => {
              void openTaskDetail(card.taskId as number);
            }}
          >
            去处理
          </button>
          <button
            type="button"
            className="card__btn card__btn--ghost"
            data-testid="card-ack"
            disabled={answerPending}
            onClick={() => {
              void submitAck();
            }}
          >
            标记已阅
          </button>
        </div>
      ) : actionable && card.kind === 'alert' && card.taskId != null ? (
        <div className="card__actions">
          <button
            type="button"
            className="card__btn card__btn--primary"
            data-testid="card-goto-task-alert"
            onClick={() => {
              void openTaskDetail(card.taskId as number);
            }}
          >
            去查看
          </button>
          <button
            type="button"
            className="card__btn card__btn--ghost"
            data-testid="card-ack"
            disabled={answerPending}
            onClick={() => {
              void submitAck();
            }}
          >
            标记已阅
          </button>
        </div>
      ) : actionable && card.kind !== 'ask' ? (
        <div className="card__actions">
          <button
            type="button"
            className="card__btn card__btn--ghost"
            data-testid="card-ack"
            disabled={answerPending}
            onClick={() => {
              void submitAck();
            }}
          >
            标记已阅
          </button>
        </div>
      ) : null}
    </CardShell>
  );
}
