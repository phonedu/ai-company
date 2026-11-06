/**
 * R2-2（G7）· 「同事提问」面板（**纯组件**，props 驱动、可 node 测）——容器接线在 `InboxView`。
 *
 * 口径：
 *  - **有提问才渲染**（空就不占版面；不造占位条目）；
 *  - 答复由主进程以 `via='boss'` 落库（**不把老板的话记到员工名下**），回灌到提问者下一轮会话；
 *  - **不计入左栏 badge**（badge 口径＝决策+验收+异常三类卡，`UI §1`）——员工间的问题本来是员工的事，
 *    老板代答是"兜底通道"，不该像待办一样催人。
 */
import type { ReactElement } from 'react';

import type { MailboxAskDTO } from '../types.js';

export interface MailboxQuestionsProps {
  questions: readonly MailboxAskDTO[];
  /** 各提问的代答草稿（key＝`askDedupeKey`）。 */
  drafts: Readonly<Record<string, string>>;
  /** 失败原因（人话；不静默）。 */
  error: string | null;
  /** 最近一次作答回执。 */
  saved: string | null;
  loading: boolean;
  onDraftChange: (askDedupeKey: string, value: string) => void;
  /** 提交代答（空草稿由容器忽略——不在组件里编业务规则，只按 props 渲染）。 */
  onAnswer: (askDedupeKey: string) => void;
}

export function MailboxQuestions(props: MailboxQuestionsProps): ReactElement | null {
  if (props.questions.length === 0) return null;

  return (
    <section className="inbox-questions" data-testid="inbox-questions" data-count={props.questions.length}>
      <h3 className="inbox-questions__title">
        同事提问（{props.questions.length}）{props.loading ? ' …' : ''}
      </h3>
      <p className="inbox-questions__hint">
        员工之间的问题（答不上来时你可以代答）；答复会带进提问者的下一轮会话。
      </p>
      {props.error ? (
        <p className="inbox-questions__error" data-testid="inbox-questions-error">
          {props.error}
        </p>
      ) : null}
      {props.saved ? (
        <p className="inbox-questions__saved" data-testid="inbox-questions-saved">
          {props.saved}
        </p>
      ) : null}
      {props.questions.map((q) => (
        <div key={q.askDedupeKey} className="inbox-question" data-testid="inbox-question" data-ask-key={q.askDedupeKey}>
          <div className="inbox-question__title">
            员工#{q.from} 问 员工#{q.to}：{q.question}
            {q.taskId ? <span className="inbox-row__short"> #{q.taskId}</span> : null}
          </div>
          <div className="inbox-question__answer">
            <input
              className="inbox-question__input"
              data-testid="inbox-question-input"
              placeholder="输入代答内容（留空不提交）"
              value={props.drafts[q.askDedupeKey] ?? ''}
              onChange={(e) => props.onDraftChange(q.askDedupeKey, e.target.value)}
            />
            <button
              type="button"
              className="inbox-question__btn"
              data-testid="inbox-question-answer"
              onClick={() => props.onAnswer(q.askDedupeKey)}
            >
              代答
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}
