/**
 * 右栏容器（2026-10-17 细节优化批 B2）。
 *
 * 只做两件事：按 `session.view` 选模式；把 store 里的真读数喂给纯展示层。
 * - 任务视图 → 产物 / 证据 / 成本（`task:get` + `cost:summary{taskId}`）。
 * - 其余视图 → 今日概览 + 资源占用 + 谁在忙（`scheduler:slots` + `cost:summary` + 大厅聚合）。
 *
 * 数据未加载 / 为空时由 `RightRailView` 显式空态，不在这里补假数据。
 */
import type { ReactElement } from 'react';
import { useSnapshot } from 'valtio';

import { cost, hall, readArtifact, session, slots, taskCost, taskDetail, selectEmployee, showHall } from '../store.js';
import type { TaskDetailDTO } from './TaskDetail.js';
import { OverviewRail, TaskRail } from './RightRailView.js';

export function RightRail(): ReactElement {
  const sessionSnap = useSnapshot(session);
  const detailSnap = useSnapshot(taskDetail);
  const costSnap = useSnapshot(cost);
  const slotsSnap = useSnapshot(slots);
  const taskCostSnap = useSnapshot(taskCost);
  const hallSnap = useSnapshot(hall);

  if (sessionSnap.view === 'task') {
    return (
      <TaskRail
        detail={detailSnap.data as unknown as TaskDetailDTO | null}
        cost={taskCostSnap.data}
        loading={detailSnap.loading}
        error={detailSnap.error}
        onPreviewArtifact={(artifactId) => void readArtifact(artifactId, 'read')}
      />
    );
  }

  return (
    <OverviewRail
      cost={costSnap.summary}
      slots={slotsSnap.data}
      employees={hallSnap.data?.employees}
      onOpenHall={showHall}
      onOpenEmployee={(id) => selectEmployee(id)}
    />
  );
}
