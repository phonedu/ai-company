import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { useSnapshot } from 'valtio';

import { appUpdate, bindIm, checkAppUpdate, clearProviderKey, imView, installAppUpdate, installSkillFolder, installSkillUrl, loadImStatus, loadMcpServers, loadModelCatalog, loadSettingsEmployees, loadSettingsView, loadSkills, loadWorkstation, mcpLibrary, modelCatalog, removeCustomProvider, removeMcpServer, removeSkill, saveCustomProvider, saveProjectDefaultBudget, saveProjectTargetBranch, testCustomProvider, saveFallbackChainSetting, saveMcpServer, saveProjectModelPolicy, saveProviderKey, saveRoleMapSetting, saveSetting, openAppDataDir, sendTestNotification, settingsEmployees, settingsView, skillsLibrary, submitImVerifyCode, toggleMcpServer, toggleSkill, showHall, unbindIm, updateEmployee, workstation } from '../store';
import { COMPANY_DAILY_BUDGET_KEY, DEFAULT_PROJECT_SETTING_KEY, MODEL_SETTING_KEY, SettingsPane, settingsGroupOf } from './SettingsPane';
import { RecruitDialog } from './RecruitDialog';
import { MaintenancePanel } from './MaintenancePanel';

// ─────────────────────────────────────────────────────────────────────────────
// R2-3 第二批 · 设置页**容器**：store ↔ 纯组件 `SettingsPane` 的接线（渲染层不做业务逻辑）。
//   件 A：`advanced`（调度与费率）同批接线——数字解析在容器，**校验真源在主进程**（`bad_value` 原因原样呈现）。
//   真机验（CDP：`scripts/verification/ui-truthful-cdp.mjs`）＋ 纯组件 node 测（`test/settings-view.test.ts`）。
// ─────────────────────────────────────────────────────────────────────────────

export function SettingsView({ initialSection }: { initialSection?: string } = {}): ReactElement {
  const snap = useSnapshot(settingsView);
  const workstationSnap = useSnapshot(workstation);
  const catalogSnap = useSnapshot(modelCatalog);
  // 2026-10-16（设置批）：员工花名册（`employee:list` 真数据；「配置 ▸」→ 员工设置为）。
  const employeesSnap = useSnapshot(settingsEmployees);
  const skillsSnap = useSnapshot(skillsLibrary);
  const mcpSnap = useSnapshot(mcpLibrary);
  const imSnap = useSnapshot(imView);
  const updateSnap = useSnapshot(appUpdate);
  // 2026-11-03 老板反馈：section 存 proxy——去员工配置再返回，落点还是「员工」不是「外观」。
  const [section, setSection] = useState<string>(() => {
    // 2026-11-04 T5（D4-N2 记账清偿）：深链 initialSection 归组并写 proxy——离开设置再回来落点不丢。
    if (initialSection != null) {
      const g = settingsGroupOf(initialSection);
      if (g != null) {
        settingsView.section = g.id;
        return g.id;
      }
    }
    return settingsView.section;
  });
  // 员工配置内联展开：点行上「配置 ▸」在本页展开，不再跳独立页（层级归零）。
  const [expandedEmployeeId, setExpandedState] = useState<number | null>(settingsView.expandedEmployeeId);
  const setExpandedEmployeeId = (id: number | null): void => {
    settingsView.expandedEmployeeId = id;
    setExpandedState(id);
  };
  // 回设置页时，共享 workstation 可能被大厅等处改写——展开的员工与详情不符就重载。
  useEffect(() => {
    const id = settingsView.expandedEmployeeId;
    if (id == null) return;
    const cur = workstation.data as { employee: { id: number } } | null;
    if (cur == null || cur.employee.id !== id) void loadWorkstation(id);
    // 仅挂载时对齐一次；展开切换由 onOpenEmployee 负责装载。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [modelDraft, setModelDraft] = useState<string>('');
  const [providerDrafts, setProviderDrafts] = useState<Record<string, string>>({});
  const [companyDailyBudgetDraft, setCompanyDailyBudgetDraft] = useState<string>('');
  const [roleMapDraft, setRoleMapDraft] = useState<string>('');
  const [fallbackChainDraft, setFallbackChainDraft] = useState<string>('');
  const [tuningDrafts, setTuningDrafts] = useState<Record<string, string>>({});
  const [draftHydrated, setDraftHydrated] = useState(false);
  /** 首次设置读取完成（不能用快照里的 loading 判断：effect 闭包可能拿到挂载时的旧值）。 */
  const [initialLoadDone, setInitialLoadDone] = useState(false);
  const [recruitOpen, setRecruitOpen] = useState(false);

  useEffect(() => {
    void (async () => {
      await Promise.all([loadSettingsView(), loadSettingsEmployees(), loadSkills(), loadMcpServers()]);
      setInitialLoadDone(true);
    })();
  }, []);
  // D-22 配套：模型分区打开时拉一次只读目录（懒加载 SDK；不阻塞其它分区）。
  // 2026-11-03 D4-N1：拍平后 section 恒为组 id——按 settingsGroupOf 归组判断，旧分区 id 判断已不可达（目录/IM 假状态回归）。
  useEffect(() => {
    if (settingsGroupOf(section)?.id !== 'model') return;
    void loadModelCatalog();
  }, [section]);
  // M3：IM 分区打开时轮询状态（扫码/连接都在主进程推进；不新增推送通道）。
  useEffect(() => {
    if (settingsGroupOf(section)?.id !== 'integrations') return;
    void loadImStatus();
    const timer = setInterval(() => {
      void loadImStatus();
    }, 2000);
    return () => clearInterval(timer);
  }, [section]);
  useEffect(() => {
    // 首次拉到现值后把草稿填上（之后不再覆盖用户输入）
    if (!draftHydrated && initialLoadDone && !snap.loading) {
      setModelDraft(snap.model ?? '');
      setCompanyDailyBudgetDraft(snap.companyDailyBudget == null ? '' : String(snap.companyDailyBudget));
      // N5：role_map 草稿＝格式化 JSON（未设置 → 空串；提交时空串＝清空）
      setRoleMapDraft(snap.roleMap == null ? '' : JSON.stringify(snap.roleMap, null, 2));
      // N5 余账：fallback_chain 同规（空串＝清空）
      setFallbackChainDraft(snap.fallbackChain == null ? '' : JSON.stringify(snap.fallbackChain, null, 2));
      const drafts: Record<string, string> = {};
      for (const [key, value] of Object.entries(snap.tuning)) drafts[key] = value == null ? '' : String(value);
      setTuningDrafts(drafts);
      setDraftHydrated(true);
    }
  }, [snap.loading, snap.model, snap.companyDailyBudget, snap.roleMap, snap.tuning, draftHydrated, initialLoadDone]);

  return (
    <>
    <SettingsPane
      section={section}
      onSectionChange={(next) => {
        settingsView.section = next;
        setSection(next);
      }}
      expandedEmployeeId={expandedEmployeeId}
      workstation={{ data: workstationSnap.data, loading: workstationSnap.loading, error: workstationSnap.error }}
      onUpdateEmployeeDetail={(patch) =>
        workstationSnap.data
          ? updateEmployee({ employeeId: (workstationSnap.data as { employee: { id: number } }).employee.id, ...patch })
          : Promise.resolve({ ok: false, error: '员工不存在' })
      }
      loading={snap.loading}
      error={snap.error}
      saved={snap.saved}
      theme={snap.theme}
      onThemeChange={(theme) => void saveSetting('ui.theme', theme)}
      onGoHall={showHall}
      employees={employeesSnap.list}
      onOpenEmployee={(id) => {
        if (expandedEmployeeId === id) {
          setExpandedEmployeeId(null);
          return;
        }
        setExpandedEmployeeId(id);
        void loadWorkstation(id);
      }}
      onRecruit={() => setRecruitOpen(true)}
      onSendTestNotification={() => void sendTestNotification()}
      imStatus={imSnap.status}
      imLoading={imSnap.loading}
      imError={imSnap.error}
      imNotice={imSnap.notice}
      onImBind={() => void bindIm()}
      onImVerifyCode={(code) => void submitImVerifyCode(code)}
      onImUnbind={() => void unbindIm()}
      onImRefresh={() => void loadImStatus()}
      skills={skillsSnap.list}
      skillsLoading={skillsSnap.loading}
      skillsNotice={skillsSnap.notice}
      skillsError={skillsSnap.error}
      onInstallSkillFolder={() => void installSkillFolder()}
      onInstallSkillUrl={(url) => void installSkillUrl(url)}
      onToggleSkill={(id, enabled) => void toggleSkill(id, enabled)}
      onRemoveSkill={(id) => {
        if (confirm('删除该技能？已安装的文件会从本机移除（不可撤销）。')) void removeSkill(id);
      }}
      mcpServers={mcpSnap.list}
      mcpLoading={mcpSnap.loading}
      mcpNotice={mcpSnap.notice}
      mcpError={mcpSnap.error}
      onSaveMcpServer={(input) => saveMcpServer(input)}
      onToggleMcp={(id, enabled) => void toggleMcpServer(id, enabled)}
      onRemoveMcp={(id) => void removeMcpServer(id)}
      model={snap.model}
      providers={snap.providers}
      providerDrafts={providerDrafts}
      onProviderDraftChange={(provider, value) =>
        setProviderDrafts((prev) => ({ ...prev, [provider]: value }))
      }
      onSaveProviderKey={(provider) => {
        const key = providerDrafts[provider] ?? '';
        void saveProviderKey(provider, key).then((ok) => {
          if (ok) setProviderDrafts((prev) => ({ ...prev, [provider]: '' }));
        });
      }}
      // 2026-10-29 P2（U-N11）：清 Key 不可撤销，先二次确认（与删除笔记同口径）。
      onClearProviderKey={(provider) => {
        if (confirm(`清除 ${provider} 的本机 Key？清除后该供应商的模型不可用，需要重新填写。`)) {
          void clearProviderKey(provider);
        }
      }}
      modelDraft={modelDraft}
      onModelDraftChange={setModelDraft}
      onSaveModel={() => void saveSetting(MODEL_SETTING_KEY, modelDraft.trim() === '' ? null : modelDraft.trim())}
      companyDailyBudget={snap.companyDailyBudget}
      companyDailyBudgetDraft={companyDailyBudgetDraft}
      onCompanyDailyBudgetDraftChange={setCompanyDailyBudgetDraft}
      onSaveCompanyDailyBudget={() => {
        const raw = companyDailyBudgetDraft.trim();
        const value = raw === '' ? null : Number(raw);
        void saveSetting(COMPANY_DAILY_BUDGET_KEY, Number.isFinite(value as number) ? value : raw);
      }}
      roleMap={snap.roleMap}
      roleMapDraft={roleMapDraft}
      onRoleMapDraftChange={setRoleMapDraft}
      onSaveRoleMap={() => void saveRoleMapSetting(roleMapDraft)}
      fallbackChain={snap.fallbackChain}
      fallbackChainDraft={fallbackChainDraft}
      onFallbackChainDraftChange={setFallbackChainDraft}
      onSaveFallbackChain={() => void saveFallbackChainSetting(fallbackChainDraft)}
      defaultProjectId={snap.defaultProjectId}
      projects={snap.projects}
      onSetDefaultProject={(id) => void saveSetting(DEFAULT_PROJECT_SETTING_KEY, id)}
      onSaveProjectDefaultBudget={(projectId, budgetTokens) => saveProjectDefaultBudget(projectId, budgetTokens)}
      openAtLogin={snap.openAtLogin}
      onToggleOpenAtLogin={(enabled) => void saveSetting('app.openAtLogin', enabled)}
      appInfo={snap.appInfo}
      updateStatus={updateSnap.status}
      onCheckUpdate={() => void checkAppUpdate()}
      onInstallUpdate={() => void installAppUpdate()}
      onOpenDataDir={() => void openAppDataDir()}
      onRetryLoad={() => void loadSettingsView()}
      onSaveProjectTargetBranch={(projectId, branch) => saveProjectTargetBranch(projectId, branch)}
      onSaveProjectModelPolicy={(input) =>
        saveProjectModelPolicy({
          projectId: input.projectId,
          policy: input.policy,
          defaultModel: input.defaultModel,
          allowedModels: input.allowedModels,
        })
      }
      modelCatalog={catalogSnap.models}
      modelCatalogLoading={catalogSnap.loading}
      modelCatalogError={catalogSnap.error}
      onReloadModelCatalog={() => void loadModelCatalog(true)}
      catalogProviders={catalogSnap.providers}
      customProviders={snap.customProviders}
      onSaveCustomProvider={(provider, key) => saveCustomProvider({ provider, key })}
      onRemoveCustomProvider={(id) => removeCustomProvider(id)}
      onTestCustomProvider={(id) => testCustomProvider(id)}
      onAddProviderKey={(provider, key) =>
        saveProviderKey(provider, key).then((ok) => ({
          ok,
          ...(ok ? {} : { error: settingsView.error ?? '保存失败' }),
        }))
      }
      tuningValues={snap.tuning}
      seams={snap.seams}
      tuningDrafts={tuningDrafts}
      onTuningDraftChange={(key, value) => setTuningDrafts((prev) => ({ ...prev, [key]: value }))}
      onSaveTuning={(key) => {
        const raw = (tuningDrafts[key] ?? '').trim();
        // 空串 = 清空（回落缺省）；数字文本 → number；其余原样发（主进程统一校验并给人话原因，不静默）
        const value = raw === '' ? null : Number.isFinite(Number(raw)) ? Number(raw) : raw;
        void saveSetting(key, value);
      }}
      maintenance={<MaintenancePanel />}
    />
    {recruitOpen ? (
      <RecruitDialog
        onClose={() => setRecruitOpen(false)}
        onRecruited={(employee) => {
          setRecruitOpen(false);
          void loadSettingsEmployees();
          // 内联展开新员工，不再跳独立页。
          setExpandedEmployeeId(employee.employee.id);
          void loadWorkstation(employee.employee.id);
        }}
      />
    ) : null}
    </>
  );
}
