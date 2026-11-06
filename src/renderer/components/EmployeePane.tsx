/**
 * D-5 补位 ① · 员工工位页（`docs/UI.md` §2/§9）——**纯展示**（props 进、DOM 出；可 `renderToStaticMarkup` 单测）。
 *
 * 2026-10-17（替换批·第七批，设计板 v2「两个口子分开」——老板裁「大厅看活、设置改人」）：
 *  - **ops ＝「员工 · 当前任务」**（自公司大厅点头像进入；只读看活）：当前在跑（短号＋题＋状态＋〔打开任务▸〕）
 *    ／最近任务／累计成本／注「改人设 / 偏好 / 技能 → 设置 · 员工」；
 *  - **config ＝「员工设置」**（自设置 · 员工「配置 ▸」进入；改人）：五 tab＝人设与提示词 / 技能 / MCP /
 *    记忆 / 定时（任务历史移出→ops）；**偏好与档位＝下拉形态**（写入口径 NI ⇒ `disabled`＋理由，
 *    值＝真字段 `employees.model/thinking`）；人设只读＋〔保存人设〕disabled（NI）＋**五层提示词预览**
 *    （①②纪律层只读不可改——EMPLOYEES §42 口径）。
 *
 * 口径：
 *  - **只读**：招募/编辑/停用属 M1+（`DEV §7.4` 员工写入口径）→ 未实现项**如实 `disabled` + 理由**；
 *  - **不臆造**：成本无行 → `—`（不写假 0）；技能/MCP 名字解析不到 → 显 `#id（未登记）`；记忆/任务无 → 空态；
 *  - 状态文案：任务状态复用 `projectView.PROJECT_STATE_LABEL`（单一映射）；工作项状态未知原样显示。
 */
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import type { EmployeeDetailDTO, EmployeeRefItem, SkillDTO } from '../types.js';
import { PROJECT_STATE_LABEL } from './projectView.js';

/** 工作项状态 → 中文（**显示用**；未知原样显示——`FLOWS §3.1.2` 表用原词，无文档级中文映射）。 */
const WORK_ITEM_STATE_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  blocked: '等同事答复',
  submitted: '已提交',
  rejected: '被打回',
  interrupted: '中断',
  done: '已完成',
  failed: '失败',
};

/** 能力档中文（`employees.capability_tier`；未知原样）。 */
const CAPABILITY_LABEL: Record<string, string> = { sandbox: '沙盒', standard: '标准', trusted: '受信' };

export type EmployeeMode = 'ops' | 'config';

/** config 五 tab（任务历史移出→ops——设计板 v2）。 */
export type EmployeeTab = 'persona' | 'skills' | 'mcps' | 'memory' | 'schedule';

const EMP_TABS: ReadonlyArray<{ key: EmployeeTab; label: string }> = [
  { key: 'persona', label: '人设与提示词' },
  { key: 'skills', label: '技能' },
  { key: 'mcps', label: 'MCP' },
  { key: 'memory', label: '记忆' },
  { key: 'schedule', label: '定时' },
];

function taskStateText(state: string): string {
  return PROJECT_STATE_LABEL[state] ?? state;
}

function workStateText(state: string): string {
  return WORK_ITEM_STATE_LABEL[state] ?? state;
}

/** 状态色：中断/失败要红，等答复要黄，执行中绿，其余灰；只辅助、不替代文字。 */
function workStateTone(state: string): 'danger' | 'warn' | 'accent' | 'dim' {
  if (state === 'failed' || state === 'interrupted' || state === 'rejected') return 'danger';
  if (state === 'blocked' || state === 'queued') return 'warn';
  if (state === 'running') return 'accent';
  return 'dim';
}

function refText(ref: EmployeeRefItem): string {
  return ref.name ?? `#${ref.id}（未登记）`;
}

function memoryZoneText(block: { projectId: number; projectName: string | null }): string {
  if (block.projectName) return block.projectName;
  return block.projectId === 0 ? '通用记忆' : `项目 #${block.projectId}`;
}

function timeText(at: number): string {
  return new Date(at).toLocaleString('zh-CN', { hour12: false });
}

export interface EmployeePaneProps {
  detail: EmployeeDetailDTO | null;
  loading?: boolean;
  error?: string | null;
  onBack: () => void;
  onOpenTask?: (taskId: number) => void;
  /** 视图口子：`ops`＝看活（大厅入口）；`config`＝改人（设置入口）。缺省 `ops`（大厅是主入口）。 */
  mode?: EmployeeMode;
  /** config 初始 tab（测试/深链用；缺省 `persona`）。 */
  initialTab?: EmployeeTab;
  /** 2026-10-17（双栏改版）：嵌入公司大厅右栏——**不渲染页头/返回**，内容同 ops（只读看活）。 */
  embedded?: boolean;
  /** GAP7：技能库（config 页「技能」tab 的勾选来源；缺省 ⇒ 只保留手填 refs）。 */
  skillOptions?: readonly SkillDTO[] | null;
  /** GAP6：MCP 库（config 页「MCP」tab 的勾选来源；只含名字/传输，不含 env 值）。 */
  mcpOptions?: readonly import('../types.js').McpServerDTO[] | null;
  /** M2 尾：改档写入口（config 页人设/模型/思考强度；缺省 ⇒ 保存 disabled，不假装可点）。 */
  onUpdateEmployee?: (patch: {
    persona?: string;
    model?: string | null;
    thinking?: string | null;
    /** OPT-AI-9：技能勾选（id 或名字；空数组＝清空）。 */
    skills?: Array<string | number>;
    /** GAP6：MCP 勾选（id 或名字；空数组＝清空）。 */
    mcps?: Array<string | number>;
    /** UG-11：能力档（sandbox/standard/trusted）。 */
    capabilityTier?: string;
    /** UG-11：停用/启用；主进程 F8 守卫（有在跑/排队件时拒）。 */
    active?: boolean;
  }) => Promise<{ ok: boolean; error?: string }>;
}

export function EmployeePane({
  detail,
  loading = false,
  error = null,
  onBack,
  onOpenTask,
  mode = 'ops',
  initialTab = 'persona',
  embedded = false,
  skillOptions,
  mcpOptions,
  onUpdateEmployee,
}: EmployeePaneProps): ReactElement {
  const [tab, setTab] = useState<EmployeeTab>(initialTab);
  const [personaDraft, setPersonaDraft] = useState(detail?.employee.persona ?? '');
  const [modelDraft, setModelDraft] = useState(detail?.employee.model ?? '');
  const [thinkingDraft, setThinkingDraft] = useState(detail?.employee.thinking ?? '');
  const [skillsDraft, setSkillsDraft] = useState((detail?.employee.skills ?? []).map((s) => s.id).join(', '));
  const [mcpsDraft, setMcpsDraft] = useState((detail?.employee.mcps ?? []).map((m) => m.id).join(', '));
  const [capabilityDraft, setCapabilityDraft] = useState(detail?.employee.capabilityTier ?? 'standard');
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  useEffect(() => {
    setPersonaDraft(detail?.employee.persona ?? '');
    setModelDraft(detail?.employee.model ?? '');
    setThinkingDraft(detail?.employee.thinking ?? '');
    setSkillsDraft((detail?.employee.skills ?? []).map((s) => s.id).join(', '));
    setMcpsDraft((detail?.employee.mcps ?? []).map((m) => m.id).join(', '));
    setCapabilityDraft(detail?.employee.capabilityTier ?? 'standard');
    setConfirmDisable(false);
    setSaveError('');
  }, [detail?.employee.id, detail?.employee.persona, detail?.employee.model, detail?.employee.thinking, detail?.employee.skills, detail?.employee.mcps, detail?.employee.capabilityTier]);
  const isConfig = mode === 'config';
  // 2026-10-17（双栏改版）：只有「员工设置」有页头/返回；ops 已并入大厅右栏（`embedded`）。
  const showHeader = isConfig && !embedded;

  async function saveProfile(): Promise<void> {
    if (!onUpdateEmployee || saving) return;
    setSaving(true);
    setSaveError('');
    const res = await onUpdateEmployee({
      persona: personaDraft,
      model: modelDraft.trim().length > 0 ? modelDraft.trim() : null,
      thinking: thinkingDraft.trim().length > 0 ? thinkingDraft : null,
      capabilityTier: capabilityDraft,
    });
    setSaving(false);
    if (!res.ok) setSaveError(res.error ?? '保存失败');
  }

  async function setActive(active: boolean): Promise<void> {
    if (!onUpdateEmployee || saving) return;
    setSaving(true);
    setSaveError('');
    const res = await onUpdateEmployee({ active });
    setSaving(false);
    if (!res.ok) {
      setSaveError(res.error ?? '操作失败');
      return;
    }
    setConfirmDisable(false);
  }

  async function saveSkills(): Promise<void> {
    if (!onUpdateEmployee || saving) return;
    setSaving(true);
    setSaveError('');
    const refs = skillsDraft
      .split(/[,，、\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const res = await onUpdateEmployee({ skills: refs });
    setSaving(false);
    if (!res.ok) setSaveError(res.error ?? '保存失败');
  }

  async function saveMcps(): Promise<void> {
    if (!onUpdateEmployee || saving) return;
    setSaving(true);
    setSaveError('');
    const refs = mcpsDraft
      .split(/[,，、\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const res = await onUpdateEmployee({ mcps: refs });
    setSaving(false);
    if (!res.ok) setSaveError(res.error ?? '保存失败');
  }
  return (
    <section className={`employee-view${embedded ? ' employee-view--embedded' : ''}`} data-testid="employee-view" data-mode={mode}>
      {showHeader ? (
      <header className="employee-view__head">
        {/* 2026-10-17（老板：返回应在左边——箭头在前、标题在后；目的地进 title/aria）。 */}
        <button
          type="button"
          className="employee-view__back"
          data-testid="employee-back"
          aria-label={isConfig ? '返回设置 · 员工' : '返回公司大厅'}
          title={isConfig ? '返回设置 · 员工' : '返回公司大厅'}
          onClick={onBack}
        >
          ←
        </button>
        <h2 className="employee-view__title">{isConfig ? '员工设置' : '员工 · 当前任务'}</h2>
      </header>
      ) : null}

      {loading ? (
        <p className="employee-view__loading" data-testid="employee-loading">
          读取中…
        </p>
      ) : error ? (
        <p className="employee-view__error" data-testid="employee-error">
          {error}
        </p>
      ) : !detail ? (
        // 不静默、不白屏：id 找不到（多半已删除）→ 如实说明（`employee:get` 返回 null）。
        <p className="employee-view__missing" data-testid="employee-missing">
          员工不存在（id 可能已删除）。请返回{isConfig ? '设置' : '公司大厅'}重选。
        </p>
      ) : (
        <>
          <div className="employee-view__head-meta" data-testid="employee-head">
            <span className="employee-view__name" data-testid="employee-name">
              {detail.employee.name}
            </span>
            <span className="employee-view__role" data-testid="employee-role">
              {detail.employee.role}
            </span>
            {detail.employee.isAssistant ? (
              <span className="employee-view__tag" data-testid="employee-assistant">
                幕僚长
              </span>
            ) : null}
            {!detail.employee.active ? (
              <span className="employee-view__tag" data-testid="employee-inactive">
                已停用
              </span>
            ) : null}
            <span className="employee-view__tier" data-testid="employee-tier">
              能力档：{CAPABILITY_LABEL[detail.employee.capabilityTier] ?? detail.employee.capabilityTier}
            </span>
          </div>

          {isConfig ? (
            <>
              <nav className="employee-view__tabs" role="tablist" aria-label="员工设置">
                {EMP_TABS.map((entry) => (
                  <button
                    key={entry.key}
                    type="button"
                    role="tab"
                    className="employee-view__tab"
                    data-testid={`employee-tab-${entry.key}`}
                    aria-selected={tab === entry.key}
                    onClick={() => setTab(entry.key)}
                  >
                    {entry.label}
                  </button>
                ))}
              </nav>

              {tab === 'persona' ? (
                <div className="employee-view__grid">
                  <section data-testid="employee-prefs">
                    <h3>偏好与档位</h3>
                    {/* M2 尾：改档写入口已接——模型为自由文本（模型目录由运行时拉取，不硬编码全表），
                        空＝跟随全局默认；思考强度为枚举下拉。保存后主进程写 `employees` 真字段。 */}
                    <div className="employee-view__row">
                      <span className="employee-view__muted">偏好模型</span>
                      <input
                        className="employee-view__input"
                        data-testid="employee-model-select"
                        list="employee-model-options"
                        value={modelDraft}
                        placeholder="例如 deepseek/deepseek-flash；空＝跟随"
                        onChange={(e) => setModelDraft(e.target.value)}
                      />
                      <datalist id="employee-model-options">
                        <option value="deepseek/deepseek-flash" />
                        <option value="deepseek/deepseek-v4-pro" />
                      </datalist>
                    </div>
                    <div className="employee-view__row">
                      <span className="employee-view__muted">思考强度</span>
                      <select
                        className="employee-view__input"
                        data-testid="employee-thinking-select"
                        value={thinkingDraft}
                        onChange={(e) => setThinkingDraft(e.target.value)}
                      >
                        <option value="">跟随默认</option>
                        <option value="off">off</option>
                        <option value="low">low</option>
                        <option value="medium">medium</option>
                        <option value="high">high</option>
                      </select>
                    </div>
                    <div className="employee-view__row">
                      <span className="employee-view__muted">能力档</span>
                      <select
                        className="employee-view__input"
                        data-testid="employee-capability-select"
                        value={capabilityDraft}
                        onChange={(e) => setCapabilityDraft(e.target.value)}
                      >
                        <option value="sandbox">沙盒（只读）</option>
                        <option value="standard">标准（写 + 命令）</option>
                        <option value="trusted">受信（可安装）</option>
                      </select>
                    </div>
                    <p className="employee-view__muted" data-testid="employee-thinking-line">
                      当前生效：模型 {detail.employee.model ?? '跟随全局默认'} · 思考强度 {detail.employee.thinking ?? '—'}
                    </p>
                  </section>

                  <section data-testid="employee-persona">
                    <h3>人设（提示词层③）</h3>
                    <textarea
                      className="employee-view__input employee-view__persona-input"
                      data-testid="employee-persona-input"
                      rows={6}
                      value={personaDraft}
                      placeholder="填写员工人设（空＝平台默认）"
                      onChange={(e) => setPersonaDraft(e.target.value)}
                    />
                    <div className="employee-view__row">
                      <button
                        type="button"
                        data-testid="employee-persona-save"
                        disabled={!onUpdateEmployee || saving}
                        title={onUpdateEmployee ? '保存人设与偏好（写下即生效于下次装配）' : '未接线'}
                        onClick={() => {
                          void saveProfile();
                        }}
                      >
                        {saving ? '保存中…' : '保存人设与偏好'}
                      </button>
                      {saveError.length > 0 ? (
                        <span className="employee-view__error" data-testid="employee-save-error" role="alert">
                          {saveError}
                        </span>
                      ) : null}
                    </div>
                    <div className="employee-view__row">
                      <button
                        type="button"
                        data-testid="employee-active-toggle"
                        disabled={!onUpdateEmployee || saving || detail.employee.isAssistant}
                        title={
                          detail.employee.isAssistant
                            ? '幕僚长不能停用（0 号员工是编排兜底）'
                            : detail.employee.active
                              ? '停用前主进程会检查在跑/排队工作项；有则拒绝'
                              : '重新启用该员工'
                        }
                        onClick={() => {
                          if (detail.employee.active) setConfirmDisable(true);
                          else void setActive(true);
                        }}
                      >
                        {detail.employee.active ? '停用员工' : '启用员工'}
                      </button>
                      {confirmDisable ? (
                        <>
                          <span className="employee-view__muted" data-testid="employee-active-confirm-note">
                            确认停用？有在跑/排队件会被主进程拒绝。
                          </span>
                          <button
                            type="button"
                            data-testid="employee-active-confirm"
                            disabled={saving}
                            onClick={() => void setActive(false)}
                          >
                            确认停用
                          </button>
                          <button
                            type="button"
                            data-testid="employee-active-cancel"
                            disabled={saving}
                            onClick={() => setConfirmDisable(false)}
                          >
                            取消
                          </button>
                        </>
                      ) : null}
                    </div>
                  </section>

                  {/* 五层提示词预览（EMPLOYEES §42 口径）：透明但不开放改纪律层。
                      CTX1-7：这里**只列层与来源**，不冒充完整拼装文本——真实拼装读数在任务右栏「任务上下文 · 上下文」里。 */}
                  <section data-testid="employee-prompt-layers">
                    <details>
                      <summary>提示词分层（只读 · 层与来源）</summary>
                      <ol className="employee-view__layers">
                        <li data-testid="emp-layer-1">① 公司纪律（只读 · 不可改）</li>
                        <li data-testid="emp-layer-2">② 平台纪律（只读 · 不可改）</li>
                        <li data-testid="emp-layer-3">③ 员工人设（本页可改 · 保存后下次装配生效）</li>
                        <li data-testid="emp-layer-4">④ 任务上下文（按任务自动拼装 · 只读）</li>
                        <li data-testid="emp-layer-5">⑤ 本轮指令（按运行自动拼装 · 只读）</li>
                      </ol>
                      <p className="employee-view__muted">
                        这里只列层与来源，不是完整拼装文本；真实拼装结果与逐层 token 请在任务右栏「任务上下文 · 上下文」里看。
                      </p>
                    </details>
                  </section>
                </div>
              ) : null}

              {tab === 'skills' ? (
                <section data-testid="employee-skills">
                  <h3>技能</h3>
                  {detail.employee.skills.length > 0 ? (
                    <ul>
                      {detail.employee.skills.map((s) => (
                        <li key={s.id} data-testid="employee-skill">
                          {refText(s)}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="employee-view__empty" data-testid="employee-skills-empty">
                      暂无技能（在「设置 · 技能」注册后，填入 id 或名字即可）。
                    </p>
                  )}
                  {skillOptions && skillOptions.length > 0 ? (
                    <div data-testid="employee-skill-options">
                      {skillOptions.map((skill) => {
                        const selectedRefs = skillsDraft.split(',').map((s) => s.trim());
                        const checked = selectedRefs.includes(String(skill.id)) || selectedRefs.includes(skill.name);
                        return (
                          <label key={skill.id} className="employee-view__row" data-testid="employee-skill-option" data-skill-name={skill.name}>
                            <input
                              type="checkbox"
                              data-testid={`employee-skill-toggle-${skill.id}`}
                              checked={checked}
                              disabled={skill.enabled !== 1 && !checked}
                              onChange={(e) => {
                                const next = selectedRefs.filter((s) => s.length > 0 && s !== String(skill.id) && s !== skill.name);
                                if (e.target.checked) next.push(skill.name);
                                setSkillsDraft(next.join(', '));
                              }}
                            />
                            <span>
                              {skill.name}
                              {skill.enabled !== 1 ? <span className="employee-view__muted">（已停用）</span> : null}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  ) : null}
                  <div className="employee-view__row">
                    <input
                      className="employee-view__input"
                      data-testid="employee-skills-input"
                      value={skillsDraft}
                      placeholder="技能 id 或名字，逗号分隔（空＝清空）"
                      onChange={(e) => setSkillsDraft(e.target.value)}
                    />
                    <button
                      type="button"
                      data-testid="employee-skills-save"
                      disabled={!onUpdateEmployee || saving}
                      title={onUpdateEmployee ? '保存技能勾选（写下即生效于下次装配）' : '未接线'}
                      onClick={() => {
                        void saveSkills();
                      }}
                    >
                      {saving ? '保存中…' : '保存技能'}
                    </button>
                  </div>
                  {saveError.length > 0 ? (
                    <span className="employee-view__error" data-testid="employee-skills-error" role="alert">
                      {saveError}
                    </span>
                  ) : null}
                </section>
              ) : null}

              {tab === 'mcps' ? (
                <section data-testid="employee-mcps">
                  <h3>MCP</h3>
                  {detail.employee.mcps.length > 0 ? (
                    <ul>
                      {detail.employee.mcps.map((m) => (
                        <li key={m.id} data-testid="employee-mcp">
                          {refText(m)}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="employee-view__empty" data-testid="employee-mcps-empty">
                      未配置（在「设置 · MCP」注册后勾选）。
                    </p>
                  )}
                  {mcpOptions && mcpOptions.length > 0 ? (
                    <div data-testid="employee-mcp-options">
                      {mcpOptions.map((server) => {
                        const selectedRefs = mcpsDraft.split(',').map((s) => s.trim());
                        const checked = selectedRefs.includes(String(server.id)) || selectedRefs.includes(server.name);
                        return (
                          <label key={server.id} className="employee-view__row" data-testid="employee-mcp-option" data-mcp-name={server.name}>
                            <input
                              type="checkbox"
                              data-testid={`employee-mcp-toggle-${server.id}`}
                              checked={checked}
                              disabled={!server.enabled && !checked}
                              onChange={(e) => {
                                const next = selectedRefs.filter((s) => s.length > 0 && s !== String(server.id) && s !== server.name);
                                if (e.target.checked) next.push(server.name);
                                setMcpsDraft(next.join(', '));
                              }}
                            />
                            <span>
                              {server.name}
                              <span className="employee-view__muted">
                                （{server.transport}{server.enabled ? '' : ' · 已停用'}）
                              </span>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  ) : null}
                  <div className="employee-view__row">
                    <input
                      className="employee-view__input"
                      data-testid="employee-mcps-input"
                      value={mcpsDraft}
                      placeholder="MCP id 或名字，逗号分隔（空＝清空）"
                      onChange={(e) => setMcpsDraft(e.target.value)}
                    />
                    <button
                      type="button"
                      data-testid="employee-mcps-save"
                      disabled={!onUpdateEmployee || saving}
                      title={onUpdateEmployee ? '保存 MCP 勾选（下次装配生效）' : '未接线'}
                      onClick={() => {
                        void saveMcps();
                      }}
                    >
                      {saving ? '保存中…' : '保存 MCP'}
                    </button>
                  </div>
                  {saveError.length > 0 ? (
                    <span className="employee-view__error" data-testid="employee-mcps-error" role="alert">
                      {saveError}
                    </span>
                  ) : null}
                </section>
              ) : null}

              {tab === 'memory' ? (
                <section data-testid="employee-memory">
                  <h3>记忆</h3>
                  {detail.memory.length > 0 ? (
                    detail.memory.map((block) => (
                      <details key={block.projectId} open data-testid="employee-memory-block" data-project-id={block.projectId}>
                        <summary>
                          {memoryZoneText(block)} · {timeText(block.updatedAt)}
                        </summary>
                        <pre className="employee-view__memory">{block.memory}</pre>
                      </details>
                    ))
                  ) : (
                    <p className="employee-view__empty" data-testid="employee-memory-empty">
                      暂无记忆（任务完成时自动沉淀；通用记忆由后续"提升"动作负责）。
                    </p>
                  )}
                </section>
              ) : null}

              {tab === 'schedule' ? (
                <section data-testid="employee-schedule">
                  <h3>定时</h3>
                  <p className="employee-view__empty" data-testid="employee-schedule-empty">
                    定时任务未实现（NI）——员工按任务派工运行，暂不支持个人定时表。
                  </p>
                </section>
              ) : null}

              {/* 未实现项：如实 disabled + 理由（不摆假控件；`DEV §7.4` 员工写入口径）。 */}
              <p className="employee-view__unimplemented" data-testid="employee-unimplemented">
                编辑技能/MCP、停用、记忆编辑：技能/MCP 随各自接线（OPT-AI-9/10）；停用与记忆编辑仍属未实现——本页人设/偏好已可改。
              </p>
            </>
          ) : (
            <>
              <div className="employee-view__grid">
                <section data-testid="employee-current">
                  <h3>当前在跑</h3>
                  {detail.currentWork.length > 0 ? (
                    <ul>
                      {detail.currentWork.map((w) => (
                        <li key={w.workItemId} data-testid="employee-current-item" data-task-id={w.taskId}>
                          <span className="employee-view__taskmain">
                            <span className="employee-view__tasktitle">{w.taskTitle}</span>
                            <span className="employee-view__taskmeta">
                              <span
                                className="employee-view__state"
                                data-testid="employee-current-state"
                                data-tone={workStateTone(w.state)}
                              >
                                {workStateText(w.state)}
                              </span>
                              <span className="employee-view__taskid" data-testid="employee-current-task">
                                {w.taskShortId ?? `#${w.taskId}`}
                              </span>
                            </span>
                          </span>
                          <button type="button" data-testid="employee-current-open" onClick={() => onOpenTask?.(w.taskId)}>
                            打开任务 ▸
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="employee-view__empty" data-testid="employee-current-empty">
                      当前没有在跑的工作项。
                    </p>
                  )}
                </section>

                <section data-testid="employee-recent">
                  <h3>最近任务</h3>
                  {detail.recentTasks.length > 0 ? (
                    <ul>
                      {detail.recentTasks.map((t) => (
                        <li key={t.id} data-testid="employee-recent-task" data-task-id={t.id}>
                          <button type="button" data-testid="employee-recent-open" onClick={() => onOpenTask?.(t.id)}>
                            {t.shortId ?? `#${t.id}`}
                          </button>
                          <span className="employee-view__muted">{taskStateText(t.state)}</span>
                          <span>{t.title}</span>
                          <span className="employee-view__muted">{timeText(t.updatedAt)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="employee-view__empty" data-testid="employee-recent-empty">
                      暂无任务记录。
                    </p>
                  )}
                </section>

                <section data-testid="employee-cost">
                  <h3>累计成本</h3>
                  {detail.cost.usd == null ? (
                    <p data-testid="employee-cost-line">成本 —（暂无成本记录）</p>
                  ) : (
                    <p data-testid="employee-cost-line">
                      ${detail.cost.usd.toFixed(4)} · 入 {detail.cost.tokensIn} / 出 {detail.cost.tokensOut} tokens · {detail.cost.rows} 次记录
                    </p>
                  )}
                </section>
              </div>

              {/* 看活视图的指路：改人不在大厅（老板裁「大厅看活、设置改人」）。 */}
              <p className="employee-view__unimplemented" data-testid="employee-ops-note">
                改人设 / 偏好 / 技能 → 设置 · 员工（花名册「配置 ▸」）。
              </p>
            </>
          )}
        </>
      )}
    </section>
  );
}
