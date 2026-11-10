import type { ReactElement, ReactNode } from 'react';

import { agentBannerOf, type AgentStatusDTO } from './agentStatus.js';
import { PanelToggleIcon, WinGlyph } from './icons.js';
import { OverviewRail } from './RightRailView.js';
import type { CostSummaryDTO } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// OPT-「假契约 / 死读数 / 结果上屏」· 壳层（**纯组件**）
//   出处：（顶栏）；设计件 §5.1/§4.1（壳层重排 v4，2026-10-16 替换批）。
//   三块（2026-10-16 壳层重排）：
//     ① **顶栏 48px**：〔左：折叠钮 ＋ 品牌〕〔中：搜索盒（Ctrl K；命令面板未实现 ⇒ disabled＋理由）〕
//        〔右：员工不可用提示 ＋ 右栏折叠钮 ＋ **自绘窗口三键**（— ▢ ✕，`ui:win-*`）〕；
//        拖拽由 `.topbar { -webkit-app-region: drag }` 承担（`frame:false`），按钮/搜索盒 no-drag。
//     ② **底栏状态条 26px**：今日成本 · 槽位 · 待办——**从顶栏迁来**（不随侧栏折叠丢信息；
//        壳层生命体征与窗口控制同层）。
//     ③ 右栏＝上下文内容（由壳注入 `RightRail`；缺省回落今日概览；折叠由壳控制）。
//   口径（2109 三条硬要求）：
//     ① **不许死读数**：每个数字都要能指到真实数据源；没有数据源就显式 `—`，绝不硬编码/伪装；
//     ② **假契约要挡住**：真实 DTO 里不存在的字段 → 渲染层显式降级（`—` / 空态 / 隐藏）；
//     ③ **有牙**：见 `test/ui-truthful-readings.test.ts`（把 `—` 改回假 `0/3` → 断言红）。
//   抽成纯组件的另一个理由：`AppShell` 依赖 store（`window.api`），node 测试编不动；
//   把"读数该显示什么"独立出来，才能**不依赖 app 启动**地断言（他人在改主进程时尤其重要）。
// ─────────────────────────────────────────────────────────────────────────────

const DISABLED_TITLE = '未实现（M1）';
/** 真·未接数据源的入口（如「槽位」）。⚠️ 勿与"源已接但暂无数据"混用 —— 那等于对用户说谎（3290）。 */
const NO_SOURCE_TITLE = '数据源未接入（M1）';
/** 「今日成本」源**已接**、只是暂无数据 → 只说"暂无数据"，不说"源未接入"。 */
const EMPTY_COST_TITLE = '暂无今日成本数据';

export interface AppChromeProps {
  /** 「待办」= 服务端 `channel:cards` 未读数；`null` = 未加载/失败 → 显 `—`（不写假 0）。 */
  todoCount: number | null;
  /** G8：员工运行时状态（来自主进程 `evt:agent`）；`failed` 时顶栏出「不可用」提示。 */
  agent?: AgentStatusDTO | null;
  /** 今日成本聚合（`cost:summary`）；`null` / `costRows===0` → 显 `—`（**不写假 0**）。 */
  cost?: CostSummaryDTO | null;
  /** R3-2：槽位真读数（`scheduler:slots`，占用/上限）；`null`/缺省 → 显 `—`（**不写假 0**）。 */
  slots?: { running: number; total: number } | null;
  /** 壳层重排：侧栏折叠态（壳持有并记忆；两钮分立顶栏左右端）。 */
  leftCollapsed?: boolean;
  rightCollapsed?: boolean;
  onToggleLeftRail?: () => void;
  onToggleRightRail?: () => void;
  /** 自绘窗口三键（`frame:false`）：动作回主进程 `ui:win-*`（壳注入；缺省＝按钮不响应）。 */
  onWinAction?: (action: 'minimize' | 'toggle-maximize' | 'close') => void;
  /** 窗口是否已最大化：决定按钮图标（最大化/还原）与可读标题。 */
  maximized?: boolean;
  /** 2026-10-18：点搜索盒 → 打开命令面板（壳持有开合态）。 */
  onOpenSearch?: () => void;
  /** 2026-10-17：右栏内容由壳注入（任务上下文 / 全局概览）；缺省回落今日概览。 */
  rightRail?: ReactNode;
}

/** 「今日成本」文案：**有真数据才显值；无数据显 `—`**（**不写假 0**）。 */
function costText(cost?: CostSummaryDTO | null): string {
  if (!cost || cost.costRows === 0 || (cost.usd <= 0 && cost.tokens <= 0)) return '今日成本 —';
  return cost.usd > 0 ? `今日成本 $${cost.usd.toFixed(4)}` : `今日成本 ${cost.tokens} tok`;
}

export function AppChrome({
  todoCount,
  agent,
  cost,
  slots,
  leftCollapsed,
  rightCollapsed,
  onToggleLeftRail,
  onToggleRightRail,
  onWinAction,
  maximized,
  onOpenSearch,
  rightRail,
}: AppChromeProps): ReactElement {
  const banner = agentBannerOf(agent);
  const hasCost = !!cost && cost.costRows > 0 && (cost.usd > 0 || cost.tokens > 0);
  return (
    <>
      <header
        className="topbar"
        data-testid="topbar"
        // 无边框窗口惯例：双击顶栏空白＝最大化/还原（按钮/搜索盒上双击不触发）。
        onDoubleClick={(event) => {
          if ((event.target as HTMLElement).closest('button, a, input')) return;
          onWinAction?.('toggle-maximize');
        }}
      >
        <div className="topbar__left">
          <button
            type="button"
            className="topbar__iconbtn"
            data-testid="rail-toggle-left"
            aria-pressed={leftCollapsed === true}
            aria-label={leftCollapsed ? '展开左栏' : '收起左栏'}
            title={leftCollapsed ? '展开左栏' : '收起左栏'}
            onClick={onToggleLeftRail}
          >
            <PanelToggleIcon side="left" />
          </button>
          <span className="topbar__brand">AI 一人公司</span>
        </div>
        <div className="topbar__center">
          {/* 2026-10-18（命令面板落地批，要求）：搜索盒**可点** → 打开命令面板（Ctrl K）。 */}
          <button
            type="button"
            className="topbar__search"
            data-testid="topbar-search"
            aria-label="打开命令面板"
            title="打开命令面板（Ctrl K）"
            onClick={onOpenSearch}
          >
            <span className="topbar__searchtext">搜索任务 / 产物 / 消息…</span>
            <span className="topbar__kbd">Ctrl K</span>
          </button>
        </div>
        <div className="topbar__right">
          {/* G8：**只在 `failed` 时**出现（其余状态零渲染 —— 不假装在跑、也不假报故障）；可点开看原因。 */}
          {banner ? (
            <details className="topbar__banner" data-testid="agent-unavailable" data-tone={banner.tone}>
              <summary>⚠️ {banner.title}</summary>
              <p className="topbar__bannercause" data-testid="agent-unavailable-reason">
                {banner.detail}
              </p>
            </details>
          ) : null}
          <button
            type="button"
            className="topbar__iconbtn"
            data-testid="rail-toggle-right"
            aria-pressed={rightCollapsed === true}
            aria-label={rightCollapsed ? '展开右栏' : '收起右栏'}
            title={rightCollapsed ? '展开右栏' : '收起右栏'}
            onClick={onToggleRightRail}
          >
            <PanelToggleIcon side="right" />
          </button>
          {/* 自绘窗口三键（`frame:false`）：关闭 hover＝红底白字。 */}
          <div className="topbar__winbtns">
            <button
              type="button"
              className="topbar__winbtn"
              data-testid="win-minimize"
              aria-label="最小化窗口"
              title="最小化"
              onClick={() => onWinAction?.('minimize')}
            >
              <WinGlyph kind="minimize" />
            </button>
            <button
              type="button"
              className="topbar__winbtn"
              data-testid="win-maximize"
              aria-label={maximized ? '还原窗口' : '最大化窗口'}
              title={maximized ? '还原' : '最大化'}
              onClick={() => onWinAction?.('toggle-maximize')}
            >
              <WinGlyph kind={maximized ? 'restore' : 'maximize'} />
            </button>
            <button
              type="button"
              className="topbar__winbtn topbar__winbtn--close"
              data-testid="win-close"
              aria-label="关闭窗口"
              title="关闭"
              onClick={() => onWinAction?.('close')}
            >
              <WinGlyph kind="close" />
            </button>
          </div>
        </div>
      </header>

      <aside className="right-rail" data-testid="right-rail" aria-label="上下文">
        {rightRail ?? <OverviewRail cost={cost} slots={slots} />}
      </aside>

      {/* 底栏状态条 26px（壳层重排 v4）：生命体征与窗口控制同层——不随侧栏折叠丢信息。 */}
      <footer className="statusbar" data-testid="statusbar">
        {/* 成本： 接入真数据源（`cost:summary`）；**无数据显 `—`**（不写假 0）。 */}
        <span
          className="statusbar__item"
          data-testid="statusbar-cost"
          data-has-cost={hasCost ? 'true' : 'false'}
          title={hasCost ? '今日成本（cost:summary，真实数据）' : EMPTY_COST_TITLE}
        >
          {costText(cost)}
          {hasCost && typeof cost?.usdPerHour === 'number' ? (
            <span className="statusbar__rate" data-testid="statusbar-cost-rate" title="最近 1 小时花费率（$/h）——看速率，不只看总额">
              {`$ ${cost.usdPerHour.toFixed(2)}/h`}
            </span>
          ) : null}
        </span>
        <span className="statusbar__sep" aria-hidden="true">
          ·
        </span>
        {/* R3-2：槽位接入真数据源（`scheduler:slots`＝正在 executing 的任务数/上限）；**无源显 `—`**（不写假 0）。 */}
        <span
          className="statusbar__item"
          data-testid="statusbar-slots"
          data-has-slots={slots ? 'true' : 'false'}
          title={slots ? '槽位 = 正在执行的任务数 / 上限（scheduler:slots，真实数据）' : NO_SOURCE_TITLE}
        >
          {slots ? `槽位 ${slots.running}/${slots.total}` : '槽位 —'}
        </span>
        <span className="statusbar__sep" aria-hidden="true">
          ·
        </span>
        {/* 口径与左栏 badge 同源同函数（`UI §409`）：决策/验收/异常中未看过的条数；FYI 通知不计。 */}
        <span
          className="statusbar__item"
          data-testid="statusbar-todo"
          title="待办 = 决策/验收/异常中你还没看过的条数（与左栏「待我处理」badge 同源；通知不计）"
        >
          待办 {todoCount ?? '—'}
        </span>
      </footer>
    </>
  );
}
