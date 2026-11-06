/**
 * M2 尾：招募员工对话框（设置 · 员工「＋招募」）。
 * 口径：人由老板招募（不是员工自主）；名字/角色必填；模型可空（空＝跟随全局默认）；
 * 主进程做项目白名单与枚举校验，失败回执说人话（不静默）。UI 复用建任务对话框的实色浮层样式。
 */
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import { recruitEmployee, modelCatalog, loadModelCatalog } from '../store';
import { useSnapshot } from 'valtio';
import type { EmployeeDetailDTO } from '../types';

export interface RecruitDialogProps {
  onClose: () => void;
  onRecruited: (employee: EmployeeDetailDTO) => void;
}

export function RecruitDialog({ onClose, onRecruited }: RecruitDialogProps): ReactElement {
  const [name, setName] = useState('');
  // 2026-10-29 P2（F-N11）：角色给预设（可自定义），模型给目录候选；不再纯自由文本。
  const ROLE_PRESETS = ['执行', '开发', '写作', '研究', '评审', '验证'];
  const [role, setRole] = useState('');
  const [customRole, setCustomRole] = useState('');
  const catalog = useSnapshot(modelCatalog);
  const [model, setModel] = useState('');
  const [persona, setPersona] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    // 模型候选：打开对话框就拉目录（用户未必先去设置页）。
    void loadModelCatalog();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function submit(): Promise<void> {
    const effectiveRole = role === '__custom__' ? customRole.trim() : role.trim();
    if (name.trim().length === 0 || effectiveRole.length === 0 || busy) return;
    setBusy(true);
    setError('');
    const res = await recruitEmployee({
      name: name.trim(),
      role: effectiveRole,
      ...(model.trim().length > 0 ? { model: model.trim() } : {}),
      ...(persona.trim().length > 0 ? { persona } : {}),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onRecruited(res.employee);
  }

  return (
    <div
      className="taskdlg-scrim"
      data-testid="recruit-dialog"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="taskdlg" role="dialog" aria-modal="true" aria-label="招募员工">
        <header className="taskdlg__head">
          <h2 className="taskdlg__title">招募员工</h2>
          <span className="taskdlg__where">人设与偏好可在「配置 ▸」里继续改</span>
          <button type="button" className="taskdlg__close" data-testid="recruit-close" aria-label="关闭" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="taskdlg__row">
          <label className="taskdlg__field">
            <span className="taskdlg__label">名字</span>
            <input
              className="taskdlg__input"
              data-testid="recruit-name"
              autoFocus
              value={name}
              placeholder="例如：林悦"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="taskdlg__field">
            <span className="taskdlg__label">角色</span>
            <select
              className="taskdlg__input"
              data-testid="recruit-role"
              value={role}
              onChange={(e) => setRole(e.target.value)}
            >
              <option value="">选择角色…</option>
              {ROLE_PRESETS.map((preset) => (
                <option key={preset} value={preset}>{preset}</option>
              ))}
              <option value="__custom__">自定义…</option>
            </select>
            {role === '__custom__' ? (
              <input
                className="taskdlg__input"
                data-testid="recruit-role-custom"
                value={customRole}
                placeholder="例如：数据分析师"
                onChange={(e) => setCustomRole(e.target.value)}
              />
            ) : null}
          </label>
        </div>

        <label className="taskdlg__field">
          <span className="taskdlg__label">偏好模型（可空；空＝跟随全局默认）</span>
          <input
            className="taskdlg__input"
            data-testid="recruit-model"
            list="recruit-model-options"
            value={model}
            placeholder="例如：deepseek/deepseek-flash（可空）"
            onChange={(e) => setModel(e.target.value)}
          />
          <datalist id="recruit-model-options">
            {(catalog.models ?? []).map((entry) => (
              <option key={`${entry.provider}/${entry.id}`} value={`${entry.provider}/${entry.id}`} />
            ))}
          </datalist>
        </label>

        <label className="taskdlg__field">
          <span className="taskdlg__label">人设（可空）</span>
          <textarea
            className="taskdlg__input"
            data-testid="recruit-persona"
            rows={4}
            value={persona}
            placeholder="长期工作风格与偏好；留空则用平台默认"
            onChange={(e) => setPersona(e.target.value)}
          />
        </label>

        {error.length > 0 ? (
          <p className="taskdlg__error" data-testid="recruit-error" role="alert">
            {error}
          </p>
        ) : null}

        <footer className="taskdlg__actions">
          <button type="button" className="taskdlg__btn" data-testid="recruit-cancel" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="taskdlg__btn taskdlg__btn--primary"
            data-testid="recruit-submit"
            disabled={busy || name.trim().length === 0 || (role === '__custom__' ? customRole.trim().length === 0 : role.trim().length === 0)}
            onClick={() => {
              void submit();
            }}
          >
            {busy ? '招募中…' : '招募'}
          </button>
        </footer>
      </section>
    </div>
  );
}
