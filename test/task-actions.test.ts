import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { cancelConfirmText, hasEnabledAction, taskActionsOf, TASK_ACTIONS_TABLE } from '../src/renderer/components/taskActions.js';
import { TaskDetail, type TaskDetailDTO } from '../src/renderer/components/TaskDetail.js';

// ─────────── D2/C3：任务详情「详情可见操作」（05 §3 逐行落点）───────────
// ① 表 = 05 §3「任务详情可见操作」列（13 状态逐行）；
// ② **未实现的动作不许假装可点**（`implemented!==true` → 渲染必须 `disabled` + 显式 `title`）；
// ③ `implemented` 不是自说自话：与 `src/main/engine/statemachine.ts` 的 **`m0:true`** 行**逐条对齐**（守卫）；
// ④ 未知 state → **空表**（不臆造按钮）。

const FLOWS_EXPECTED: Record<string, string[]> = {
  // 05 §3：「任务详情可见操作」列（按状态逐行）
  inbox: ['confirm-as-task', 'discard'], // [确认为任务] [丢弃]
  planning: ['cancel'], // [取消]
  awaiting_approval: ['approve', 'revise', 'revise-approve'], // [批准][打回][改]
  ready: ['pause', 'cancel'], // [暂停][取消]
  executing: ['pause', 'add-budget', 'set-priority', 'finish', 'cancel'], // [暂停][加预算][改优先级][结束][取消]（取消＝危险动作，行内二次确认；D-9）
  paused: ['resume', 'finish'], // [继续][结束]
  blocked: ['unblock', 'cancel'], // [解除阻塞][取消]（阻塞原因由 task-waits 承担；依赖未满足会被调度器再阻塞）
  verifying: ['accept', 'reject', 'merge', 'cancel'], // [通过][打回][合并][取消]（取消＝危险动作·行内二次确认；余两态批）
  needs_decision: [], // 问题上下文 + 选项（AskCard 承担）
  done: ['renew', 'undo-finish'], // 只读；[续办] (+7 天内 [撤销结束])
  failed: ['retry', 'renew'], // 只读；[重试]（异常卡未处理时）；[续办]
  cancelled: ['renew'], // 只读；[续办]
  // 05 §3 L187/L268：**「归档」不再是本表一行**（归档 = `tasks.archived` 列 + 筛选开关）⇒ 状态集 = 12
};

/** 解析 `statemachine.ts`：`from` + `event` + `m0` 三元组（split-with-capture，按出现顺序切块）。 */
function statemachineRows(): Map<string, boolean> {
  const src = readFileSync('src/main/engine/statemachine.ts', 'utf8');
  // 支持 `from: 'x'` 与多来源行 `from: ['x', 'y']`（后者展开为多个 (state,event) 键）
  const parts = src.split(/from:\s*(\[[^\]]*\]|'[a-z_]+')/);
  const rows = new Map<string, boolean>();
  for (let i = 1; i < parts.length; i += 2) {
    const fromRaw = parts[i] ?? '';
    const chunk = parts[i + 1] ?? '';
    const states = fromRaw.startsWith('[')
      ? [...fromRaw.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] ?? '')
      : [fromRaw.replace(/'/g, '')];
    const event = /event:\s*'([a-z_]+)'/.exec(chunk)?.[1];
    if (!event) continue;
    for (const state of states) rows.set(`${state}:${event}`, /m0:\s*true/.test(chunk));
  }
  return rows;
}

test('① 表 = 05 §3「任务详情可见操作」列（13 状态逐行对齐）', () => {
  for (const [state, expected] of Object.entries(FLOWS_EXPECTED)) {
    const actual = taskActionsOf(state).map((a) => a.id);
    assert.deepEqual(actual, expected, `state=${state} 的可见操作与 05 §3 不一致`);
  }
  assert.equal(Object.keys(TASK_ACTIONS_TABLE).length, Object.keys(FLOWS_EXPECTED).length, '状态数=12');
});

test('② 未知/缺省 state → **空表**（不臆造按钮）', () => {
  for (const state of [undefined, null, '', 'weird_state', 'INBOX']) {
    assert.deepEqual(taskActionsOf(state as string | null | undefined), []);
    assert.equal(hasEnabledAction(state as string | null | undefined), false);
  }
});

test('③ 守卫：`implemented:true` 必须能在 statemachine 找到 **m0:true** 的 (state,event)；反之不得漏标', () => {
  const rows = statemachineRows();
  assert.ok(rows.size > 20, `statemachine 解析出 ${rows.size} 行（应远大于 20）`);
  for (const [state, actions] of Object.entries(TASK_ACTIONS_TABLE)) {
    for (const action of actions) {
      if (action.event === null) {
        // M3-P-4：非状态机动作（`task:merge`）显式声明 ipcAction 后才可标已实现；
        // 其余无事件动作仍必须 disabled（不许"看起来能点"）。
        if (action.ipcAction) assert.equal(action.implemented, true, `${state}/${action.id}: ipcAction 应已实现`);
        else assert.equal(action.implemented, false, `${state}/${action.id}: 无事件却标了已实现`);
        continue;
      }
      const m0 = rows.get(`${state}:${action.event}`);
      if (action.implemented) {
        assert.equal(m0, true, `${state}/${action.id}: 标为已实现，但 statemachine 里没有 m0:true 的 ${state}+${action.event}`);
      } else {
        assert.notEqual(m0, true, `${state}/${action.id}: statemachine 已实现（m0:true）却被标为未实现 —— 请更新表或移除误导`);
      }
    }
  }
});

test('④ 未实现的动作渲染必须 `disabled`（不许"看起来能点"）', () => {
  const detail = fixture('awaiting_approval');
  const html = renderToStaticMarkup(createElement(TaskDetail, { data: detail, initialTab: 'plan' }));
  // 批准/打回（m0:true）可点；GAP8「改计划再批准」也已接线（点按打开计划编辑器，保存时发 plan_edited）。
  assert.match(html, /data-testid="task-action-approve"[^>]*data-implemented="true"/);
  assert.doesNotMatch(html, /data-testid="task-action-approve"[^>]*\sdisabled=/);
  assert.match(html, /data-testid="task-action-revise"[^>]*data-implemented="true"/);
  assert.doesNotMatch(html, /data-testid="task-action-revise"[^>]*\sdisabled=/);
  assert.match(html, /data-testid="task-action-revise-approve"[^>]*data-implemented="true"/);
  assert.match(html, /data-testid="task-action-revise-approve"[^>]*data-opens-editor="true"/);
  assert.doesNotMatch(html, /data-testid="task-action-revise-approve"[^>]*\sdisabled=/);
});

test('⑤ 无表态的 state（needs_decision）与未知 state → **不渲染操作条**', () => {
  for (const state of ['needs_decision', 'weird_state']) {
    const html = renderToStaticMarkup(createElement(TaskDetail, { data: fixture(state), initialTab: 'plan' }));
    assert.equal(html.includes('data-testid="task-actions"'), false, `state=${state} 不应出现操作条`);
  }
});

test('⑥ 变更合并：`merge` 走独立 IPC（非任务机事件）且已实现', () => {
  const merge = taskActionsOf('verifying').find((action) => action.id === 'merge');
  assert.ok(merge);
  assert.equal(merge?.implemented, true);
  assert.equal(merge?.event, null);
  assert.equal(merge?.ipcAction, 'task:merge');
});

test('⑥b 事件载荷：验收「通过/打回」带 verdict（供 `task:transition` 用）', () => {
  const accept = taskActionsOf('verifying').find((a) => a.id === 'accept');
  const reject = taskActionsOf('verifying').find((a) => a.id === 'reject');
  assert.deepEqual(accept?.payload, { verdict: 'pass' });
  assert.deepEqual(reject?.payload, { verdict: 'fail' });
  assert.equal(accept?.event, 'verification_completed');
  assert.equal(reject?.event, 'verification_completed');
});

// ─────────── BRK17（挂载 3 余·取消小步，D-9）：危险动作＝行内二次确认 ───────────

test('⑦ 「取消」是危险动作：executing 行标 `danger:true`＋渲染带 `data-danger`；未确认前不直发', () => {
  const cancel = taskActionsOf('executing').find((a) => a.id === 'cancel');
  assert.ok(cancel, 'executing 行含 [取消]');
  assert.equal(cancel?.implemented, true, '取消小步已接线（真中止＋收尾卡）');
  assert.equal(cancel?.danger, true, '标为危险动作（UI 走行内二次确认）');
  assert.equal(cancel?.event, 'cancel');

  // 静态标记：危险按钮带 `data-danger="true"`；确认条**初始不渲染**（点击后才出——静态渲染看不到）。
  const html = renderToStaticMarkup(createElement(TaskDetail, { data: fixture('executing'), initialTab: 'plan' }));
  assert.match(html, /data-testid="task-action-cancel"[^>]*data-danger="true"/);
  assert.equal(html.includes('data-testid="task-action-confirm"'), false, '未点击 ⇒ 不预置确认条');
  // UI 简化：主操作只留「暂停」；加预算/改优先级/结束/取消进 ⋯（DOM 仍在，可点击展开）。
  assert.match(html, /class="[^"]*td__action--primary[^"]*"[^>]*data-testid="task-action-pause"/);
  assert.match(html, /data-testid="task-actions-more"/);
});

test('⑦b 确认文案：件数取真读数；查不到/为 0 ⇒ 不写数字（不臆造）', () => {
  const full = cancelConfirmText({ shortId: 'T-1042', counts: { running: 2, submitted: 1 } });
  assert.equal(full, '中止 T-1042？在跑的 2 个件与员工会话会停 · 已提交的 1 个件不再验证 · 不可回退（只能续办）。');
  const noNumbers = cancelConfirmText({ shortId: null, counts: null });
  assert.equal(
    noNumbers,
    '中止 本任务？在跑的件（如有）与员工会话会停 · 不可回退（只能续办）。',
    '无读数 ⇒ 不写任何数字（含已提交从句一并省略）',
  );
  const zeroSubmitted = cancelConfirmText({ shortId: 'T-1042', counts: { running: 1 } });
  assert.equal(zeroSubmitted.includes('不再验证'), false, 'submitted=0 ⇒ 无「不再验证」从句');
});

function fixture(state: string): TaskDetailDTO {
  const at = 1_700_000_000_000;
  return {
    task: {
      id: 1,
      shortId: 'T-1001',
      projectId: 1,
      title: 't',
      goal: 'g',
      state,
      riskLevel: 1,
      priority: 0,
      createdAt: at,
      updatedAt: at,
      acceptance: [],
    },
    progress: { done: 0, total: 0 },
    planSteps: [],
    timeline: [],
    behaviorLog: [],
    counts: { planSteps: 0, timeline: 0, behaviorLog: 0, acceptance: 0 },
  };
}
