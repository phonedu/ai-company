/**
 * OPT-EXT-2 · 「待我处理」视图（`UI §51`）。
 *
 * **同源**：直接读 `store.cards.list`（= `inbox:list()`，与老板频道同一份数据）→ 老板频道/待我处理
 * **一处处理、另一处同步消除**（动作走后端的 `answerCard`/`acknowledgeCard`，随后 `loadChannel()` 刷新同源）。
 * 本文件**不碰 Node/DB/fs**（`DEV §7.4`）；tab/分组逻辑在纯函数 `inboxView.ts`（可单测）。
 */
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import { useSnapshot } from 'valtio';

import { acknowledgeCard, acknowledgeCards, answerCard, answerMailboxAsk, cards, focusChannelCard, loadChannel, loadMailbox, mailbox, markInboxRead, openTaskFromLink, showChannel } from '../store';
import type { ReportDTO } from '../types';
import { remainText, verdictText, verdictTone } from './cardCopy';
import { isMultiSelect, permissionDetailLines } from './cardAnswer';
import { EmptyState } from './EmptyState.js';
import { digestLine, groupByTab, inboxEntries, planSummary, sourceLabel, visibleTabs, waitedText } from './inboxModel';
import { MailboxQuestions } from './MailboxQuestions';

function titleOf(card: ReportDTO): string {
  return card.payload.title ?? card.payload.question ?? card.payload.tldr ?? card.payload.summary ?? '（无标题）';
}

/**
 * RM-2（2026-10-19 真机）：长题面/长批注先在卡片里显示 `clamp` 行，可展开读全文；
 * 不再只给一句被截断的标题。展开态用 CSS 变量控制行数（见 styles.css）。
 */
function FoldText({
  text,
  clamp = 2,
  testid,
}: {
  text: string;
  clamp?: number;
  testid: string;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const textRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    setOverflowing(false);
  }, [text, clamp]);
  useEffect(() => {
    const el = textRef.current;
    if (!el || open) return;
    const measure = (): void => {
      if (el.scrollHeight > el.clientHeight + 1) setOverflowing(true);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, clamp, open]);
  // 兜底阈值 40 字：分屏窄栏里 2–3 行大约 40–60 字，不能只靠 140 字才给展开。
  const long = overflowing || text.length > 40 || text.split('\n').length > clamp;
  return (
    <div className="inbox-row__fold" data-testid={testid} data-open={open ? 'true' : 'false'}>
      <div
        ref={textRef}
        className="inbox-row__foldtext"
        style={{ '--fold-lines': clamp } as CSSProperties}
      >
        {text}
      </div>
      {long ? (
        <button
          type="button"
          className="inbox-row__foldbtn"
          data-testid={`${testid}-toggle`}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? '收起' : '展开'}
        </button>
      ) : null}
    </div>
  );
}

/** 超时注文案（`timeoutAt`/`defaultAction` 真读数；到点怎么说清——与频道卡同口径）。 */
function timeoutNote(due: number, defaultAction: string, now: number): string {
  const remain = remainText(due, now);
  return remain === '已到点' ? `已到点——默认按 ${defaultAction} 执行` : `剩余 ${remain}——到点默认按 ${defaultAction} 执行`;
}

export function InboxView(): ReactElement {
  const cardsSnap = useSnapshot(cards);
  const mailboxSnap = useSnapshot(mailbox);
  const list = cardsSnap.list as unknown as ReportDTO[];
  const groups = groupByTab(list);
  const entries = inboxEntries(list);
  const questions = mailboxSnap.questions;
  /** M4-C-4：首载与失败不伪装成“没有事”；有旧数据时保留列表并显式报错。 */
  const initialLoading = cardsSnap.loading && !cardsSnap.loaded;
  const maxEntryId = entries.length > 0 ? entries[entries.length - 1]!.id : 0;
  // 空 tab 不渲染（F-B 修复）：只列“有卡”的 tab；无卡则 0 个（进空态）。
  const tabs = visibleTabs(list);
  const [tab, setTab] = useState<string>('ask');
  // R2-2：各提问的代答草稿（key＝askDedupeKey）。
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, string>>({});
  // RM-2：无预设选项的决策卡——卡片内直接输入回答（key＝report id）。
  const [replyDrafts, setReplyDrafts] = useState<Record<number, string>>({});
  // 时间锚/倒计时的参照时刻（挂载时取一次；推送到达会重渲——不追秒，够用且不摆假精度）。
  const [now] = useState(() => Date.now());
  const [ackBusy, setAckBusy] = useState(false);
  const [ackNotice, setAckNotice] = useState('');
  // 本次进入「待我处理」只推进一次游标；之后到达的新卡必须保持未读（不能“打开页面就全已读”）。
  const markedRef = useRef(0);

  useEffect(() => {
    void loadChannel();
    void loadMailbox();
  }, []);

  // M3-REM-1c：进视图看到当前这批卡即推进服务端卡片游标；新卡到达不自动标读。
  useEffect(() => {
    if (markedRef.current !== 0 || maxEntryId <= 0) return;
    markedRef.current = maxEntryId;
    void markInboxRead(maxEntryId);
  }, [maxEntryId]);

  // 数据驱动：当前 tab 若为空，落到第一个有卡的 tab（避免"点进去是空"）。
  const activeTab = (groups[tab]?.length ?? 0) > 0 ? tab : (tabs[0]?.key ?? 'ask');
  const rows = groups[activeTab] ?? [];
  const reportTargets = (groups.report ?? []).filter((card) => card.state === 'pending' || card.state === 'delivered');
  // 2026-11-04 老板：决策常在老板频道里已解决（自由文本走语义路由，不回写卡片表），
  // 待办卡却一直挂着——给一个「全部清除」兜底（含决策/异常/通知），确认文案如实说明后果。
  const allTargets = entries;

  async function acknowledgeAllReports(): Promise<void> {
    if (ackBusy || reportTargets.length === 0) return;
    setAckBusy(true);
    setAckNotice('');
    const result = await acknowledgeCards(reportTargets);
    setAckBusy(false);
    setAckNotice(result.error ? `已标记 ${result.count} 张，随后失败：${result.error}` : `已标记已阅 ${result.count} 张`);
  }

  async function clearAllCards(): Promise<void> {
    if (ackBusy || allTargets.length === 0) return;
    const asks = allTargets.filter((card) => card.kind === 'ask').length;
    if (
      !confirm(
        `确定清除全部 ${allTargets.length} 张待办卡（含验收卡——已阅后不再催办）？` +
          (asks > 0 ? `其中 ${asks} 张是决策卡——若你还没在频道/详情里真作答，任务会继续等（卡片消失≠已解决）。` : ''),
      )
    ) {
      return;
    }
    setAckBusy(true);
    setAckNotice('');
    const result = await acknowledgeCards(allTargets);
    setAckBusy(false);
    setAckNotice(result.error ? `已清除 ${result.count} 张，随后失败：${result.error}` : `已清除 ${result.count} 张`);
  }

  return (
    <section className="inbox-view" data-testid="inbox-view">
      {/* 层级纪律（2026-10-16 待我处理批）：一级页**无返回钮/面包屑**——原返回入口已删。 */}
      <header className="inbox-view__head">
        <h2 className="inbox-view__title">待我处理</h2>
        {/* D3 老板抽查（2026-11-03）：验收卡批量已阅；2026-11-04 老板：频道里解决了决策但卡不清——
            加「全部清除」兜底（含决策/异常/通知；确认文案如实说明决策未真作答的后果）。 */}
        {reportTargets.length > 0 ? (
          <button
            type="button"
            className="inbox-ack-all"
            data-testid="inbox-ack-all"
            disabled={ackBusy}
            title="只标记验收卡已阅（其他 tab 也可用）"
            onClick={() => {
              void acknowledgeAllReports();
            }}
          >
            {ackBusy ? '处理中…' : `验收全部已阅（${reportTargets.length}）`}
          </button>
        ) : null}
        {allTargets.length > 0 ? (
          <button
            type="button"
            className="inbox-ack-all inbox-clear-all"
            data-testid="inbox-clear-all"
            disabled={ackBusy}
            title="清除全部待办卡（含决策/异常/通知/验收）；决策未真作答时任务会继续等，验收卡已阅后不再催办"
            onClick={() => {
              void clearAllCards();
            }}
          >
            {ackBusy ? '处理中…' : `全部清除（${allTargets.length}）`}
          </button>
        ) : null}
      </header>

      {ackNotice.length > 0 ? (
        <p className="inbox-view__notice" data-testid="inbox-ack-notice">
          {ackNotice}
        </p>
      ) : null}

      <div className="inbox-tabs" data-testid="inbox-tabs" data-count={tabs.length}>
        {tabs.map((t) => {
          const count = groups[t.key].length;
          return (
            <button
              key={t.key}
              type="button"
              className="inbox-tab"
              data-testid={`inbox-tab-${t.key}`}
              data-active={t.key === activeTab ? 'true' : 'false'}
              data-count={count}
              onClick={() => setTab(t.key)}
            >
              {t.label} {count}
            </button>
          );
        })}
      </div>

      {cardsSnap.error ? (
        <p className="inbox-view__error" data-testid="inbox-error" role="alert">
          待我处理加载失败：{cardsSnap.error}
        </p>
      ) : null}
      {initialLoading ? (
        <p className="inbox-view__loading" data-testid="inbox-loading">
          加载中…
        </p>
      ) : entries.length === 0 && questions.length === 0 ? (
        // UI §471：空就是空，不造占位条目；加载失败时不显示假空态。
        cardsSnap.error ? null : (
          <EmptyState
            testid="inbox-empty"
            variant="page"
            title="没有要你拍板的事。"
            hint="决策、验收、异常会出现在这里。"
            action={
              <button type="button" className="card__btn card__btn--ghost" data-testid="inbox-empty-channel" onClick={() => showChannel()}>
                回老板频道
              </button>
            }
          />
        )
      ) : (
        <ul className="inbox-list" data-testid="inbox-list" data-count={entries.length}>
          {rows.map((card) => {
            const due = typeof card.payload.timeoutAt === 'number' ? card.payload.timeoutAt : null;
            const defaultAction = typeof card.payload.defaultAction === 'string' ? card.payload.defaultAction : null;
            // 日报在列表里也要能读到关键读数；普通卡有 tldr/summary 时一并展示（ask 的题面已是标题）。
            const summary = card.payload.tldr ?? card.payload.summary;
            const digest = card.kind === 'notification' ? digestLine(card.payload.digest) : null;
            // GAP8：批准卡在列表里也给计划摘要（编辑后随卡 payload 刷新）。
            // 2026-11-06：只有数组才当计划（同名非数组字段会让 planSummary/.map 崩溃）。
            const planLine = card.kind === 'ask' && Array.isArray(card.payload.planSteps) ? planSummary(card.payload.planSteps) : null;
            // GAP12：验证/评审结论与批注上屏（reports.verdict 真列优先）。
            const verdict = verdictText(card.verdict ?? card.payload.verdict);
            const reviewNote =
              typeof card.payload.notes === 'string' && card.payload.notes.trim().length > 0
                ? card.payload.notes.trim()
                : null;
            return (
              <li key={card.id} className="inbox-row" data-testid="inbox-row" data-kind={card.kind} data-card-id={card.id}>
                <div className="inbox-row__head">
                  <span className="inbox-row__source" data-testid="inbox-source">
                    {card.projectName != null && card.projectName.length > 0 ? `${card.projectName} · ` : ''}
                    {sourceLabel(card.kind)}
                  </span>
                  <span className="inbox-row__sep" aria-hidden="true">
                    ｜
                  </span>
                  {/* 短号可点（凡短号出现处皆可点）：→ 任务详情；全局卡（无 taskId）如实标「全局」。 */}
                  {card.taskId != null ? (
                    <button
                      type="button"
                      className="inbox-row__short inbox-row__short--link"
                      data-testid="inbox-short"
                      title="打开任务详情"
                      onClick={() => {
                        void openTaskFromLink(card.taskId as number);
                      }}
                    >
                      {card.shortId ?? `#${card.taskId}`}
                    </button>
                  ) : (
                    <span className="inbox-row__short">全局</span>
                  )}
                  <span className="inbox-row__wait" data-testid="inbox-wait">
                    等了 {waitedText(card.createdAt, now)}
                  </span>
                </div>
                <div className="inbox-row__title">
                  <FoldText text={titleOf(card)} clamp={2} testid="inbox-title" />
                </div>
                {card.payload.card === 'permission' && permissionDetailLines(card.payload) != null ? (
                  /* 卡片可读性批：权限行显「谁 申请：干什么 · 项目」（技术串在频道卡折叠里） */
                  <div className="inbox-row__question" data-testid="inbox-question">
                    <FoldText
                      text={`${permissionDetailLines(card.payload)!.who} 申请：${permissionDetailLines(card.payload)!.action} · ${permissionDetailLines(card.payload)!.project}`}
                      clamp={3}
                      testid="inbox-question-fold"
                    />
                  </div>
                ) : card.payload.question &&
                card.payload.question !== titleOf(card) &&
                !(card.kind === 'ask' && card.payload.question === `需要你决策（${card.shortId ?? `#${card.taskId}`}）`) ? (
                  <div className="inbox-row__question" data-testid="inbox-question">
                    <FoldText text={card.payload.question} clamp={3} testid="inbox-question-fold" />
                  </div>
                ) : null}
                {typeof card.payload.modelRejected === 'string' && card.payload.modelRejected.trim().length > 0 ? (
                  <p className="inbox-row__summary" data-testid="inbox-model-rejected">
                    {card.payload.modelRejected}
                  </p>
                ) : null}
                {verdict != null ? (
                  <p
                    className="inbox-row__verdict"
                    data-testid="inbox-verdict"
                    data-tone={verdictTone(card.verdict ?? card.payload.verdict)}
                  >
                    结论：{verdict}
                  </p>
                ) : null}
                {reviewNote != null ? (
                  <div className="inbox-row__review" data-testid="inbox-review">
                    <FoldText text={reviewNote} clamp={3} testid="inbox-review-fold" />
                  </div>
                ) : null}
                {summary && card.kind !== 'ask' && summary !== titleOf(card) ? (
                  <p className="inbox-row__summary" data-testid="inbox-summary">
                    {summary}
                  </p>
                ) : null}
                {/* E-16：卡正文（招募卡的人设/模型/技能等）——此前 body 无任何渲染面，内容是死数据。 */}
                {card.payload.body ? (
                  <FoldText text={card.payload.body} clamp={3} testid="inbox-body-fold" />
                ) : null}
                {planLine ? (
                  <p className="inbox-row__plan" data-testid="inbox-plan">
                    计划：{planLine}
                  </p>
                ) : null}
                {card.kind === 'ask' && Array.isArray(card.payload.planSteps) && card.payload.planSteps.length > 0 ? (
                  <details className="inbox-row__planmore" data-testid="inbox-plan-full">
                    <summary>完整计划（{card.payload.planSteps.length} 步）</summary>
                    <ol>
                      {card.payload.planSteps.map((step, index) => (
                        <li key={`${index}-${step.slice(0, 12)}`}>{step}</li>
                      ))}
                    </ol>
                  </details>
                ) : null}
                {digest ? (
                  <p className="inbox-row__digest" data-testid="inbox-digest">
                    {digest}
                  </p>
                ) : null}
                {card.kind === 'ask' && card.payload.options && card.payload.options.length > 0 ? (
                  isMultiSelect(card.payload) ? (
                    /* 多选卡（老板 2026-10-28 指令）：行内不做即点（会误答）——引导去频道勾选提交。 */
                    <div className="inbox-row__options">
                      <button
                        type="button"
                        className="inbox-row__btn inbox-row__btn--primary"
                        data-testid="inbox-multi-goto"
                        onClick={() => {
                          void focusChannelCard(card.id);
                        }}
                      >
                        多选 · 在频道作答
                      </button>
                    </div>
                  ) : (
                  <>
                    <div className="inbox-row__options">
                      {card.payload.options.map((option) => (
                        <button
                          key={option.key}
                          type="button"
                          className={`inbox-row__btn${option.recommended ? ' inbox-row__btn--primary' : ''}`}
                          data-testid="inbox-option"
                          data-option={option.key}
                          onClick={() => {
                            void answerCard(card, option.key);
                          }}
                        >
                          {option.label}
                          {option.recommended && !(option.label ?? '').includes('（推荐）') ? '（推荐）' : ''}
                        </button>
                      ))}
                      <button
                        type="button"
                        className="inbox-row__btn inbox-row__btn--ghost"
                        data-testid="inbox-goto-channel"
                        onClick={() => {
                          void focusChannelCard(card.id);
                        }}
                      >
                        在频道看
                      </button>
                    </div>
                    {due != null && defaultAction != null ? (
                      <p
                        className="inbox-row__timeout"
                        data-testid="inbox-timeout"
                        data-near={due - now <= 3_600_000 ? 'true' : 'false'}
                      >
                        {timeoutNote(due, defaultAction, now)}
                      </p>
                    ) : null}
                  </>
                  )
                ) : (
                  <div className="inbox-row__options">
                    {card.kind === 'ask' && card.payload.card === 'decision' && card.approvalId != null ? (
                      <div className="inbox-row__reply" data-testid="inbox-reply">
                        <input
                          className="inbox-row__replyinput"
                          data-testid="inbox-reply-input"
                          value={replyDrafts[card.id] ?? ''}
                          placeholder="直接回复这张卡（不必切到频道）"
                          onChange={(event) =>
                            setReplyDrafts((prev) => ({ ...prev, [card.id]: event.target.value }))
                          }
                          onKeyDown={(event) => {
                            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                            const text = (replyDrafts[card.id] ?? '').trim();
                            if (!text) return;
                            setReplyDrafts((prev) => ({ ...prev, [card.id]: '' }));
                            void answerCard(card, text);
                          }}
                        />
                        <button
                          type="button"
                          className="inbox-row__btn inbox-row__btn--primary"
                          data-testid="inbox-reply-send"
                          disabled={(replyDrafts[card.id] ?? '').trim().length === 0}
                          onClick={() => {
                            const text = (replyDrafts[card.id] ?? '').trim();
                            if (!text) return;
                            setReplyDrafts((prev) => ({ ...prev, [card.id]: '' }));
                            void answerCard(card, text);
                          }}
                        >
                          回复
                        </button>
                      </div>
                    ) : null}
                    {card.taskId != null ? (
                      <button
                        type="button"
                        className="inbox-row__btn"
                        data-testid="inbox-goto-task-detail"
                        onClick={() => {
                          void openTaskFromLink(card.taskId as number);
                        }}
                      >
                        任务详情
                      </button>
                    ) : null}
                    {card.kind === 'report' && card.taskId != null ? (
                      <button
                        type="button"
                        className="inbox-row__btn inbox-row__btn--primary"
                        data-testid="inbox-goto-task"
                        onClick={() => {
                          void openTaskFromLink(card.taskId as number);
                        }}
                      >
                        去验收
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="inbox-row__btn"
                      data-testid="inbox-ack"
                      onClick={() => {
                        void acknowledgeCard(card);
                      }}
                    >
                      标记已阅
                    </button>
                    <button
                      type="button"
                      className="inbox-row__btn inbox-row__btn--ghost"
                      data-testid="inbox-goto-channel"
                      onClick={() => {
                        void focusChannelCard(card.id);
                      }}
                    >
                      在频道看
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* R2-2（G7）：同事提问——纯组件（可 node 测）＋ store 接线（作答经 mailbox:answer，via='boss'）。 */}
      <MailboxQuestions
        questions={questions}
        drafts={answerDrafts}
        error={mailboxSnap.error}
        saved={mailboxSnap.saved}
        loading={mailboxSnap.loading}
        onDraftChange={(key, value) => setAnswerDrafts((prev) => ({ ...prev, [key]: value }))}
        onAnswer={(key) => {
          const text = (answerDrafts[key] ?? '').trim();
          if (text.length === 0) return; // 空=不提交（按钮仍在，避免静默）
          void answerMailboxAsk(key, text);
        }}
      />
    </section>
  );
}
