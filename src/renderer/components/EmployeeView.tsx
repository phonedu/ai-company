/**
 * D-5 补位 ① · 员工视图 · 容器：把 `store.workstation`（`employee:get`）接到纯展示的 `EmployeePane`。
 * 纯展示与文案逻辑在 `EmployeePane.tsx`（可单测）；本文件只取数 + 动作接线。
 *
 * 2026-10-17（双栏改版）：`ops`（员工 · 当前任务）已并入公司大厅右栏——本视图只剩
 * `config`＝「员工设置」（设置·员工入口；返回＝设置）。
 */
import { useEffect } from 'react';
import type { ReactElement } from 'react';
import { useSnapshot } from 'valtio';

import { loadMcpServers, loadSkills, mcpLibrary, skillsLibrary, updateEmployee, openTaskDetail, showSettings, workstation } from '../store.js';
import type { EmployeeDetailDTO } from '../types.js';
import { EmployeePane } from './EmployeePane.js';

export function EmployeeView(): ReactElement {
  const snap = useSnapshot(workstation);
  const skillsSnap = useSnapshot(skillsLibrary);
  const mcpSnap = useSnapshot(mcpLibrary);

  useEffect(() => {
    void loadSkills();
    void loadMcpServers();
  }, []);

  return (
    <EmployeePane
      detail={snap.data as unknown as EmployeeDetailDTO | null}
      loading={snap.loading}
      error={snap.error}
      skillOptions={skillsSnap.list}
      mcpOptions={mcpSnap.list}
      mode="config"
      onBack={showSettings}
      onOpenTask={(taskId) => {
        void openTaskDetail(taskId);
      }}
      onUpdateEmployee={(patch) =>
        snap.data
          ? updateEmployee({ employeeId: (snap.data as unknown as EmployeeDetailDTO).employee.id, ...patch })
          : Promise.resolve({ ok: false, error: '员工不存在' })
      }
    />
  );
}
