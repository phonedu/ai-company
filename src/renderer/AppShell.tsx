import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { useSnapshot } from 'valtio';

import { AppChrome } from './components/AppChrome';
import { BossChannel } from './components/BossChannel';
import { KnowledgePage } from './components/KnowledgePage';
import { CommandPalette } from './components/CommandPalette';
import { CompanyHall } from './components/CompanyHall';
import { EmployeeView } from './components/EmployeeView';
import { InboxView } from './components/InboxView';
import { ProjectsPage } from './components/ProjectsPage';
import { archivedProjectsFromList } from './components/projectView.js';
import { SettingsView } from './components/SettingsView';
import { ArchiveView } from './components/TaskListViews';
import { OnboardingGate } from './components/OnboardingGate';
import { LeftRail } from './components/LeftRail';
import { isNarrowViewport, NARROW_QUERY } from './components/SplitLayout';
import { TaskDetailView } from './components/TaskDetailView';
import { RightRail } from './components/RightRail';
import { ToastHost } from './components/ToastHost';
import { paletteResults } from './components/paletteModel';
import { archiveView, inbox, loadAppUpdateStatus, messages, openTaskDetail, openTaskFromLink, readArtifact, renewTaskFromArchive, session, showChannel, showInbox, showHall, tasks, agent, cost, slots, onboarding, loadCostSummary, loadSlots, loadHall, loadOnboarding, loadTasks, restoreSession, subscribeEvents, searchGlobal, subscribeAppUpdateStatus, toasts, dismissToast, projectActions, restoreProject, exportProject, deleteProject, loadProjectsForOverview, showProject } from './store';
import type { ToastDTO } from './components/toastModel.js';
import { attemptMountReport, MOUNT_REPORT_RETRY_MS } from './mountReport';
import type { GlobalSearchDTO, HumanMessageDTO, TaskDTO } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// T0.1 · AppShell：五个落点（topbar / left-rail / center / right-rail / **statusbar**）。
//   布局出处：DEV §7.1（AppShell 组件树）、UI.md §1（左栏结构）；
//   **壳层重排 v4（2026-10-16）**：顶栏＝品牌＋搜索盒＋折叠钮＋自绘三键（`frame:false`）；
//   读数（今日成本/槽位/待办）迁**底栏状态条**（`AppChrome` 同件渲染）；左右侧栏折叠态入本地记忆。
//   **视图导航只在左栏**（UI §1：固定入口 + 任务树；中栏是“七选一”视图）；顶栏**不放视图切换**。
// ─────────────────────────────────────────────────────────────────────────────

// OPT-M7-1：顶栏/右栏的「读数」全部移到纯组件 `AppChrome`（可被 node 测试直接断言）。

// StrictMode 在开发模式下会双调用 effect（挂载 → 卸载 → 再挂载）；
// 模块级标记保证「壳已挂载」只上报一次（否则会重复 IPC / 重复截图）。
// ⚠️ 该标记**只能在成功上报之后**置位（`attemptMountReport` 内部做）——
//    否则 preload 未就绪时会被"已置位"的守卫吞掉信号且永不重试（报告的偶发缺陷）。
let shellMountedOnce = false;

/** 侧栏折叠态记忆（壳层重排 v4：折叠状态入设置记忆；读失败/无存储 → 都展开＝缺省）。 */
const RAIL_KEY = 'aico.rail.collapsed';

/** F-07（2026-10-24）：今日成本不能只在挂载时拉一次；任务跑几分钟后必须能看到新读数。 */
const COST_REFRESH_MS = 30_000;


function readRailCollapsed(): { left: boolean; right: boolean } {
  try {
    const raw = window.localStorage.getItem(RAIL_KEY);
    // 2026-10-23 UI 简化：右栏默认收起（上下文按需从顶栏开关临时展开）；
    // 左栏仍默认展开。已有本地偏好优先，不覆盖用户上次选择。
    if (!raw) return { left: false, right: true };
    const parsed = JSON.parse(raw) as { left?: unknown; right?: unknown };
    return { left: parsed.left === true, right: parsed.right === true };
  } catch {
    return { left: false, right: true };
  }
}

export function AppShell(): ReactElement {
  const sessionSnap = useSnapshot(session);
  const agentSnap = useSnapshot(agent);
  const costSnap = useSnapshot(cost);
  const slotsSnap = useSnapshot(slots);
  const onboardingSnap = useSnapshot(onboarding);
  const inboxSnap = useSnapshot(inbox);
  const toastsSnap = useSnapshot(toasts);
  // 「待办」= 与左栏 badge **同源**：服务端 `read_cursors` 的 `channel:cards` 未读数
  //（ask/report/alert 的 pending/delivered；FYI 不计）。未加载/失败 → null（显 —，不写假 0）。
  const todoCount = inboxSnap.unread;
  // 壳层重排 v4（2026-10-16）：左右侧栏折叠态（顶栏两钮驱动；本地记忆，下次启动沿用）。
  const [railCollapsed, setRailCollapsed] = useState(readRailCollapsed);
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    try {
      window.localStorage.setItem(RAIL_KEY, JSON.stringify(railCollapsed));
    } catch {
      // 存不上不阻断使用（隐私模式等）；折叠仍当次生效。
    }
  }, [railCollapsed]);

  // 窄窗（≤1040）：右栏**自动收起**；用户在窄窗顶栏手动展开只影响本次窄窗，
  // 不覆盖宽窗的持久化偏好。离开窄窗后回到用户原来的右栏偏好。
  const [narrow, setNarrow] = useState(isNarrowViewport);
  const [rightNarrowOpen, setRightNarrowOpen] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    const onChange = (): void => {
      setNarrow(mq.matches);
      if (mq.matches) setRightNarrowOpen(false);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const rightCollapsed = narrow ? !rightNarrowOpen : railCollapsed.right;

  /** 2026-10-18（命令面板落地批）：面板开合与查询（受控于壳；Ctrl K / 点搜索盒开）。 */
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [paletteGlobal, setPaletteGlobal] = useState<GlobalSearchDTO | null>(null);
  const tasksSnap = useSnapshot(tasks);
  const projectsSnap = useSnapshot(projectActions);
  // UI-2 S2b：归档项目列表（归档页集中管理恢复/导出/删除）。
  const archivedProjects = archivedProjectsFromList(
    projectsSnap.list as unknown as import('./types.js').ProjectDTO[],
    tasksSnap.list as unknown as TaskDTO[],
  );
  const messagesSnap = useSnapshot(messages);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && (event.key === 'k' || event.key === 'K')) {
        event.preventDefault();
        setPaletteOpen(true);
        return;
      }
      // 2026-10-29 P2（P-N02）：docs/06 §12 承诺 Ctrl+1/2/3 → 频道/待我处理/大厅。
      // 输入框/可编辑区里不抢（避免打断输入法）。
      if ((event.ctrlKey || event.metaKey) && (event.key === '1' || event.key === '2' || event.key === '3')) {
        const target = event.target as HTMLElement | null;
        const typing =
          !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
        if (typing) return;
        event.preventDefault();
        setPaletteOpen(false);
        if (event.key === '1') showChannel();
        else if (event.key === '2') showInbox();
        else showHall();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  // M2 尾（G-D）：跨项目全局搜索（200ms 防抖；空/过短查询不请求）。
  useEffect(() => {
    if (!paletteOpen || paletteQuery.trim().length < 2) {
      setPaletteGlobal(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void searchGlobal(paletteQuery).then((result) => {
        if (!cancelled) setPaletteGlobal(result);
      });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [paletteOpen, paletteQuery]);
  const paletteHit = paletteResults(
    paletteQuery,
    tasksSnap.list as unknown as TaskDTO[],
    messagesSnap.list as unknown as HumanMessageDTO[],
    paletteGlobal,
  );
  const closePalette = (): void => {
    setPaletteOpen(false);
    setPaletteQuery('');
  };

  /** 自绘三键 → 主进程（`ui:win-*`）；preload 未就绪＝静默不炸（真机上主进程必然有）。 */
  const onWinAction = (action: 'minimize' | 'toggle-maximize' | 'close'): void => {
    const win = window.api?.win;
    if (!win) return;
    if (action === 'minimize') void win.minimize();
    else if (action === 'toggle-maximize') {
      void win.toggleMaximize().then(async () => {
        const value = await win.isMaximized();
        setMaximized(value === true);
      });
    } else void win.close();
  };

  useEffect(() => {
    let alive = true;
    const sync = async (): Promise<void> => {
      const value = await window.api?.win?.isMaximized?.();
      if (alive) setMaximized(value === true);
    };
    void sync();
    window.addEventListener('resize', sync);
    return () => {
      alive = false;
      window.removeEventListener('resize', sync);
    };
  }, []);

  useEffect(() => {
    // 渲染层自己的跟踪日志；主进程据此收到「壳已挂载」信号（日志 / 截图基线）。
    console.log('[ui] AppShell rendered');
    // P-02（bench）：首个 React effect＝窗口可交互的时间点（同机 epoch ms；主进程减 bootAt）。
    const g = globalThis as { __AICO_INTERACTIVE_AT__?: number };
    if (g.__AICO_INTERACTIVE_AT__ == null) g.__AICO_INTERACTIVE_AT__ = Date.now();
    // 上报策略：**未就绪就重试，成功才置位，真失败留痕**（详见 mountReport.ts）。
    const state = { done: shellMountedOnce, attempts: 0 };
    let cancelled = false;
    const run = (): void => {
      if (cancelled) return;
      const outcome = attemptMountReport(() => {
        const api = window.api;
        return api?.ui?.mounted ? () => api.ui.mounted() : undefined;
      }, state);
      if (outcome === 'reported') {
        shellMountedOnce = true;
        return;
      }
      if (outcome === 'gave_up') {
        // 不静默：主进程/日志能看出「壳已挂载但没上报成功」（而非无声无息）。
        console.warn(
          `[ui] ui:mounted 上报失败：preload（window.api.ui）未就绪，已重试 ${state.attempts} 次`,
        );
        return;
      }
      window.setTimeout(run, MOUNT_REPORT_RETRY_MS);
    };
    run();
    // OPT-EXT-6：启动时恢复上次视图（失真则回落 channel）。
    void restoreSession();
    // 2026-10-17（建任务入口批）：左栏不再拉任务——任务表改由壳统一拉（项目树/命令面板同源）。
    void loadTasks();
    // OPT-EXT-13：拉今日成本（真实数据源；空 => 顶栏显 —）。
    void loadCostSummary();
    // F-07：成本会随任务增长；30s 轮询 + 回到前台立即刷新，避免一直显示旧读数。
    const costTimer = window.setInterval(() => {
      void loadCostSummary();
    }, COST_REFRESH_MS);
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void loadCostSummary();
    };
    document.addEventListener('visibilitychange', onVisibility);
    // R3-2：拉顶栏槽位真读数（引擎未装配 => null => 显 —）。
    void loadSlots();
    // 2026-10-17（B2）：右栏「谁在忙」用大厅聚合（只读；失败/空 => 显式空态）。
    void loadHall();
    // R2-4：读首启状态（未完成 → 显示向导弹层；完成/跳过写 `onboarding.completed`）。
    void loadOnboarding();
    return () => {
      cancelled = true;
      window.clearInterval(costTimer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // 自动更新：拉一次当前状态 + 订阅主进程推送（设置页展示；不阻塞首帧）。
  useEffect(() => {
    void loadAppUpdateStatus();
    const unsub = subscribeAppUpdateStatus();
    return () => { unsub?.(); };
  }, []);

  // 窗口级拖放守卫（裁决②）：拖文件到窗口任意处（UI §4.6）都不得触发页面导航。
  // 不 stopPropagation，drop 仍能冒泡到 composer 的 onDrop。
  useEffect(() => {
    const block = (event: DragEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('dragover', block);
    window.addEventListener('drop', block);
    return () => {
      window.removeEventListener('dragover', block);
      window.removeEventListener('drop', block);
    };
  }, []);

  // V3 修（真机复跑抓到）：**事件订阅挂到壳（AppShell）而非老板频道**——
  //   此前订阅随 `BossChannel` 卸载而断开（切到「待我处理」/任务详情/大厅即丢推送），
  //   且进频道不重拉任务表 ⇒ 左栏任务分组停在旧状态（真机基线截图：任务已 done，左栏仍列在「待批准」）。
  //   订阅是**全局单点**（`subscribeEvents` 内部 `evt:batch` 分发到各 domain 的 reload），
  //   放壳上只在应用生命周期挂/卸一次，不随视图切换丢失。
  useEffect(() => {
    const off = subscribeEvents();
    return () => {
      off?.();
    };
  }, []);

  return (
    <div
      className="app-shell"
      data-testid="app-shell"
      data-left-collapsed={railCollapsed.left ? 'true' : 'false'}
      data-right-collapsed={rightCollapsed ? 'true' : 'false'}
    >
      <AppChrome
        todoCount={todoCount}
        agent={agentSnap.status}
        cost={costSnap.summary}
        slots={slotsSnap.data}
        leftCollapsed={railCollapsed.left}
        rightCollapsed={rightCollapsed}
        maximized={maximized}
        onToggleLeftRail={() => setRailCollapsed((state) => ({ ...state, left: !state.left }))}
        onToggleRightRail={() => {
          if (narrow) setRightNarrowOpen((open) => !open);
          else setRailCollapsed((state) => ({ ...state, right: !state.right }));
        }}
        onWinAction={onWinAction}
        onOpenSearch={() => setPaletteOpen(true)}
        rightRail={<RightRail />}
      />

      <LeftRail />

      <main className="center" data-testid="center" data-view={sessionSnap.view}>
        {sessionSnap.view === 'hall' ? (
          <CompanyHall />
        ) : sessionSnap.view === 'task' ? (
          <TaskDetailView />
        ) : sessionSnap.view === 'inbox' ? (
          <InboxView />
        ) : sessionSnap.view === 'employee' ? (
          <EmployeeView />
        ) : sessionSnap.view === 'settings' ? (
          <SettingsView />
        ) : sessionSnap.view === 'projects' ? (
          <ProjectsPage />
        ) : sessionSnap.view === 'notes' ? (
          <KnowledgePage />
        ) : sessionSnap.view === 'archive' ? (
          <ArchiveView
            tasks={tasksSnap.list as unknown as TaskDTO[]}
            onOpenTask={(taskId) => void openTaskDetail(taskId)}
            onRenewTask={(taskId) => void renewTaskFromArchive(taskId)}
            renewNotice={archiveView.notice}
            error={tasksSnap.error}
            onRetry={() => void Promise.all([loadProjectsForOverview(), loadTasks({ includeArchived: true })]).then(() => undefined)}
            archivedProjects={archivedProjects.map((g) => ({ projectId: g.projectId, name: g.name, alias: g.alias, taskCount: g.taskCount }))}
            onOpenProject={(projectId) => showProject(projectId)}
            onRestoreProject={(projectId) => void restoreProject(projectId)}
            onExportProject={(projectId) => void exportProject(projectId)}
            onDeleteProject={(projectId) => void deleteProject(projectId)}
            actionError={projectsSnap.error}
            actionMessage={projectsSnap.message}
          />
        ) : (
          <BossChannel />
        )}
      </main>

      {/* R2-4：首次启动向导弹层（3 屏＋完成屏，每步可跳过；`onboarding.completed` 之后不再显示）。 */}
      {onboardingSnap.state === 'show' ? <OnboardingGate /> : null}

      {/* 2026-10-18（命令面板落地批）：Ctrl K 搜索（任务/消息；选中任务→详情，消息→频道）。 */}
      <CommandPalette
        open={paletteOpen}
        query={paletteQuery}
        results={paletteHit}
        onQueryChange={setPaletteQuery}
        onClose={closePalette}
        onPick={(item) => {
          closePalette();
          if (item.kind === 'global') {
            // UG-05：产物命中先开任务详情，再开该产物的统一预览抽屉；消息仍回频道。
            if (item.artifactId != null && item.taskId != null) {
              const artifactId = item.artifactId;
              const taskId = item.taskId;
              void openTaskDetail(taskId).then(() => readArtifact(artifactId, 'read'));
              return;
            }
            if (item.taskId != null) void openTaskFromLink(item.taskId);
            else showChannel();
            return;
          }
          if (item.kind === 'task') void openTaskFromLink(item.id);
          else showChannel();
        }}
      />

      {/* 2026-10-17 真机反馈「没通知」：OS 通知之外的应用内可见回执（右下角，6s 自动消失）。 */}
      <ToastHost items={toastsSnap.list as unknown as ToastDTO[]} onDismiss={dismissToast} />
    </div>
  );
}
