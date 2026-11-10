/**
 *  · 设置·权限只读审计 + 撤销。
 *
 * 数据：`settings:permission-list`（permission_policies + [权限] approvals）；
 * 撤销：`settings:permission-revoke` 只删 scope 策略，二次确认；审批历史只读。
 */
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import { getApi } from '../api.js';

interface PolicyRow {
  id: number;
  scopeType: string;
  scopeId: number;
  scopeName: string | null;
  tier: string;
  grants: number | null;
  updatedAt: number;
}

interface ApprovalRow {
  id: number;
  taskId: number | null;
  question: string;
  chosen: string | null;
  decidedBy: string | null;
  decidedAt: number | null;
  timeoutAt: number | null;
}

type ListResponse =
  | { ok: true; policies?: PolicyRow[]; approvals?: ApprovalRow[] }
  | { ok: false; message?: string; code?: string }
  | undefined;

type RevokeResponse =
  | { ok: true; removed?: number }
  | { ok: false; message?: string; code?: string }
  | undefined;

const TIER_LABEL: Readonly<Record<string, string>> = { strict: '严格', standard: '标准', loose: '宽松' };

export function policyScopeLabel(policy: Pick<PolicyRow, 'scopeType' | 'scopeId' | 'scopeName'>): string {
  if (policy.scopeType === 'global') return '全局';
  if (policy.scopeType === 'project') return `项目 · ${policy.scopeName ?? `#${policy.scopeId}`}`;
  return `任务 · #${policy.scopeId}`;
}

function timeText(ts: number | null): string {
  if (ts == null || !Number.isFinite(ts)) return '—';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

export function PermissionsPanel(): ReactElement {
  const [policies, setPolicies] = useState<PolicyRow[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ scopeType: string; scopeId: number } | null>(null);
  const [revoking, setRevoking] = useState(false);

  const load = async (): Promise<void> => {
    const api = getApi();
    if (!api?.settings?.permissionList) {
      setLoading(false);
      setError('权限通道不可用（主进程未连接）');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = (await api.settings.permissionList()) as ListResponse;
      if (res && res.ok === true) {
        setPolicies(Array.isArray(res.policies) ? res.policies : []);
        setApprovals(Array.isArray(res.approvals) ? res.approvals : []);
      } else {
        setError(res && res.ok === false ? (res.message ?? res.code ?? '读取权限失败') : '读取权限失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const revoke = async (scopeType: string, scopeId: number): Promise<void> => {
    if (revoking) return;
    const api = getApi();
    if (!api?.settings?.permissionRevoke) return;
    setRevoking(true);
    setError(null);
    setNotice(null);
    try {
      const res = (await api.settings.permissionRevoke({ scopeType, scopeId })) as RevokeResponse;
      if (res && res.ok === true) {
        setNotice(`已撤销 ${scopeType}:${scopeId} 的权限策略；下一次动作重新走闸门。`);
        setConfirming(null);
        await load();
      } else {
        setError(res && res.ok === false ? (res.message ?? res.code ?? '撤销失败') : '撤销失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRevoking(false);
    }
  };

  return (
    <div data-testid="settings-permissions">
      <p style={{ color: 'var(--text-dim)', fontSize: 12 }}>
        只读审计：已授权策略与最近权限审批；撤销只删整条 scope 策略，需要二次确认。
      </p>
      {notice ? (
        <p className="settings-notice" data-testid="settings-permissions-notice" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="settings-error" data-testid="settings-permissions-error" role="alert">
          {error}
        </p>
      ) : null}
      {loading ? (
        <p className="settings-muted" data-testid="settings-permissions-loading">
          读取中…
        </p>
      ) : policies.length === 0 ? (
        <p className="settings-muted" data-testid="settings-permissions-empty">
          还没有权限策略。项目级放行档/命令放行/临时 grant 会出现在这里。
        </p>
      ) : (
        <ul className="settings-list" data-testid="settings-permission-policies">
          {policies.map((policy) => {
            const confirmingThis =
              confirming?.scopeType === policy.scopeType && confirming.scopeId === policy.scopeId;
            return (
              <li key={`${policy.scopeType}:${policy.scopeId}`} data-testid="settings-permission-policy">
                <div>
                  <strong>{policyScopeLabel(policy)}</strong>
                  <p className="settings-muted">
                    放行档 {TIER_LABEL[policy.tier] ?? policy.tier} · grant {policy.grants == null ? '—' : policy.grants} · 更新 {timeText(policy.updatedAt)}
                  </p>
                </div>
                {confirmingThis ? (
                  <span>
                    <button
                      type="button"
                      data-testid="settings-permission-revoke-confirm"
                      disabled={revoking}
                      onClick={() => void revoke(policy.scopeType, policy.scopeId)}
                    >
                      确认撤销
                    </button>
                    <button
                      type="button"
                      data-testid="settings-permission-revoke-cancel"
                      disabled={revoking}
                      onClick={() => setConfirming(null)}
                    >
                      取消
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    data-testid="settings-permission-revoke"
                    onClick={() => setConfirming({ scopeType: policy.scopeType, scopeId: policy.scopeId })}
                  >
                    撤销
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <h4>审批历史（最近）</h4>
      {approvals.length === 0 ? (
        <p className="settings-muted" data-testid="settings-permission-approvals-empty">
          暂无权限审批记录。
        </p>
      ) : (
        <ul className="settings-list" data-testid="settings-permission-approvals">
          {approvals.map((approval) => (
            <li key={approval.id} data-testid="settings-permission-approval">
              <div>
                <strong>{approval.question}</strong>
                <p className="settings-muted">
                  {approval.chosen == null
                    ? '待处理'
                    : `选择 ${approval.chosen} · ${approval.decidedBy ?? '—'} · ${timeText(approval.decidedAt)}`}
                  {approval.taskId != null ? ` · 任务 #${approval.taskId}` : ''}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
