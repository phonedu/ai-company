/**
 * 公司大厅 · 容器（2026-10-17 双栏改版）：把 `store.hall` 接到纯展示的 `CompanyHallView`，
 * 并把「选中员工 / 右栏分区 / 员工详情」三者接起来——
 *   左列点人 → `selectEmployee`（右栏切换，不跳页）；左列「部门协作」→ `openHallCollab`；
 *   「＋招募」→ 大厅内招募对话框（成功刷新花名册并选中新人，不跳频道）。
 * 纯展示与分组/协作文案逻辑在 `CompanyHallView.tsx`（可单测）；本文件只取数 + 补选。
 * 事件订阅只在 `AppShell` 全局单点（BRK19）；本组件**不得**再挂 `subscribeEvents`（避免双通道重复 reload）。
 */
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { useSnapshot } from 'valtio';

import { hall, loadHall, openHallActivity, openHallCollab, openTaskDetail, selectEmployee, session, showChannel, showHall, workstation } from '../store';
import type { EmployeeDetailDTO, HallStateDTO } from '../types';
import { CompanyHallView } from './CompanyHallView';
import { RecruitDialog } from './RecruitDialog';

export function CompanyHall(): ReactElement {
  const [recruitOpen, setRecruitOpen] = useState(false);
  const snap = useSnapshot(hall);
  const sessionSnap = useSnapshot(session);
  const workstationSnap = useSnapshot(workstation);
  const data = snap.data as unknown as HallStateDTO | null;
  const employees = data?.employees ?? [];
  const selected = sessionSnap.selectedEmployeeId;

  useEffect(() => {
    void loadHall();
  }, []);

  // 进页补选第一个员工（**按左列展示顺序**：先各部门、后未分组）；选中失效同样补选。
  // 只切右栏，不跳页。
  useEffect(() => {
    if (employees.length === 0) return;
    if (selected == null || !employees.some((employee) => employee.id === selected)) {
      const firstInGroups =
        data?.departments.map((dept) => dept.memberIds[0]).find((id): id is number => typeof id === 'number' && employees.some((e) => e.id === id)) ??
        employees[0].id;
      selectEmployee(firstInGroups);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在「选中缺失/失效」时补选
  }, [selected, employees.length]);

  const detailReady = workstationSnap.employeeId === selected;

  return (
    <>
      <CompanyHallView
        data={data}
        loading={snap.loading}
        error={snap.error}
        selectedEmployeeId={selected}
        pane={sessionSnap.hallPane}
        employeeDetail={detailReady ? (workstationSnap.data as unknown as EmployeeDetailDTO | null) : null}
        employeeLoading={detailReady ? workstationSnap.loading : true}
        employeeError={detailReady ? workstationSnap.error : null}
        onSelectEmployee={(id) => selectEmployee(id)}
        onOpenCollab={openHallCollab}
        onOpenActivity={openHallActivity}
        onRecruit={() => setRecruitOpen(true)}
        onOpenTask={(taskId) => {
          void openTaskDetail(taskId);
        }}
        onBackFromEmployee={showHall}
        onGoChannel={showChannel}
      />
      {recruitOpen ? (
        <RecruitDialog
          onClose={() => setRecruitOpen(false)}
          onRecruited={(employee) => {
            setRecruitOpen(false);
            void loadHall();
            selectEmployee(employee.employee.id);
          }}
        />
      ) : null}
    </>
  );
}
