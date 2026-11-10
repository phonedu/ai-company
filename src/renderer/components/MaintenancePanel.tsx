/**
 * B-4· 设置·高级「数据保留」容器：`settings:maintenance` ↔ 纯视图。
 * 预览只数不删；运行前二次确认；只清四张临时表。
 */
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import { getApi } from '../api.js';
import { MaintenanceView, type RetentionCounts } from './MaintenanceView.js';

type MaintenanceResponse =
  | { ok: true; action: 'preview' | 'run'; retentionDays: number; counts: RetentionCounts }
  | { ok: false; code?: string; message?: string }
  | undefined;

function countsText(counts: RetentionCounts): string {
  return `远端事件 ${counts.remoteEvents} / outbox ${counts.outbox} / 检查点 ${counts.checkpoints} / 定时器 ${counts.timers}`;
}

export function MaintenancePanel(): ReactElement {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [counts, setCounts] = useState<RetentionCounts | null>(null);
  const [confirming, setConfirming] = useState(false);

  const call = async (action: 'preview' | 'run'): Promise<void> => {
    const api = getApi();
    if (!api?.settings?.maintenance) {
      setError('维护通道不可用（主进程未连接）');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = (await api.settings.maintenance({ action })) as MaintenanceResponse;
      if (res && res.ok === true) {
        setCounts(res.counts);
        setNotice(
          action === 'run'
            ? `已清理：${countsText(res.counts)}；任务/报告/产物/变更集未动`
            : `预览：${countsText(res.counts)}（尚未删除）`,
        );
      } else {
        setError(res && res.ok === false ? (res.message ?? res.code ?? '维护失败') : '维护失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setConfirming(false);
    }
  };

  useEffect(() => {
    void call('preview');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <MaintenanceView
      loading={loading}
      error={error}
      notice={notice}
      counts={counts}
      confirming={confirming}
      onPreview={() => void call('preview')}
      onAskRun={() => {
        setNotice(null);
        setConfirming(true);
      }}
      onRun={() => void call('run')}
      onCancelRun={() => setConfirming(false)}
    />
  );
}
