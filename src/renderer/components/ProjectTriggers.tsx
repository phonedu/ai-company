/**
 * B-1（M4）· 项目概览「定时」卡（触发管理 UI 容器）。
 *
 * 口径（`docs/06`：「管理入口在项目概览 → 定时」）：
 *  - 列表/创建/取消/下次时间；数据源＝`project:trigger-manage`（与频道 `定时 …` 命令同源 TriggerService）；
 *  - **只列本项目**（主进程按 projectId 过滤；前端不拼别的项目）；
 *  - 空态不伪装；事件触发没有「下次时间」→ 显示「等待源任务完成」；已触发/已取消如实提示。
 *  - 纯视图在 `ProjectTriggersView.tsx`（无 store 依赖，可 node 静态渲染测试）。
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { useSnapshot } from 'valtio';

import {
  cancelProjectTrigger,
  createProjectCronTrigger,
  createProjectEventTrigger,
  loadProjectTriggers,
  projectActions,
} from '../store.js';
import type { TriggerDTO } from '../types.js';
import { parseDailyTime, ProjectTriggersView } from './ProjectTriggersView.js';

/** 容器：接 store；切项目时重拉列表（旧项目数据不串屏）。 */
export function ProjectTriggers({ projectId }: { projectId: number | null }): ReactElement {
  const snap = useSnapshot(projectActions);
  const [goal, setGoal] = useState('');
  const [kind, setKind] = useState<'interval' | 'daily' | 'event'>('interval');
  const [interval, setInterval] = useState('30');
  const [daily, setDaily] = useState('09:00');
  const [source, setSource] = useState('');
  const [creating, setCreating] = useState(false);
  // 双击/连点：React 状态更新要等重渲染，闭包里的 creating 挡不住同一 tick 的第二次点击；
  // 用同步 ref 先占位（F-2 ⑤ 真机：双击曾落两条相同触发）。
  const creatingRef = useRef(false);
  const [cancelingId, setCancelingId] = useState<number | null>(null);

  useEffect(() => {
    // 切项目：草稿/回执随项目走，避免把 A 的未提交内容或成功提示带到 B。
    setGoal('');
    setKind('interval');
    setInterval('30');
    setDaily('09:00');
    setSource('');
    projectActions.triggerNotice = null;
    if (projectId != null) void loadProjectTriggers(projectId);
  }, [projectId]);

  const belongs = projectId != null && snap.triggersProjectId === projectId;
  const triggers = belongs ? (snap.triggers as TriggerDTO[]) : [];
  const loading = projectId != null && (!belongs || snap.triggersLoading);
  const error = belongs ? snap.triggersError : null;
  const notice = belongs ? snap.triggerNotice : null;

  const onCreate = async (): Promise<void> => {
    if (projectId == null || creatingRef.current) return;
    const intervalMinutes = kind === 'interval' ? Number(interval) : undefined;
    const dailyMinute = kind === 'daily' ? parseDailyTime(daily) : undefined;
    if (kind === 'interval' && (!Number.isInteger(intervalMinutes) || (intervalMinutes ?? 0) <= 0)) return;
    if (kind === 'daily' && dailyMinute == null) return;
    if (kind === 'event' && source.trim().length === 0) return;
    creatingRef.current = true;
    setCreating(true);
    try {
      const result =
        kind === 'event'
          ? await createProjectEventTrigger({ projectId, goal: goal.trim(), sourceShortId: source.trim() })
          : await createProjectCronTrigger({
              projectId,
              goal: goal.trim(),
              ...(kind === 'interval' ? { intervalMinutes } : { dailyMinute: dailyMinute as number }),
            });
      if (result.ok) {
        setGoal('');
        if (kind === 'event') setSource('');
      }
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  const onCancel = async (id: number): Promise<void> => {
    if (projectId == null || cancelingId != null) return;
    setCancelingId(id);
    try {
      await cancelProjectTrigger(projectId, id);
    } finally {
      setCancelingId(null);
    }
  };

  return (
    <ProjectTriggersView
      projectId={projectId}
      loading={loading}
      error={error}
      notice={notice}
      triggers={triggers}
      goal={goal}
      kind={kind}
      interval={interval}
      daily={daily}
      source={source}
      creating={creating}
      cancelingId={cancelingId}
      onGoalChange={setGoal}
      onKindChange={setKind}
      onIntervalChange={setInterval}
      onDailyChange={setDaily}
      onSourceChange={setSource}
      onCreate={() => void onCreate()}
      onCancel={(id) => void onCancel(id)}
      onRefresh={() => {
        if (projectId != null) void loadProjectTriggers(projectId);
      }}
    />
  );
}
