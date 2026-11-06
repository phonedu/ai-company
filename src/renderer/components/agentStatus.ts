// ─────────────────────────────────────────────────────────────────────────────
// 员工运行时「不可用态」的界面投影（G8）· **纯函数**（可 node 测）
//   来源：主进程 `evt:agent` 事件（`onStatus` 三态：idle/assembling/ready/failed）。
//   口径（2876 / G8）：
//     ① **只在 `failed` 时出提示**（其余状态**零渲染** —— 既不假装在跑，也不假报故障）；
//     ② 提示要能**点到原因**（`<details>`），且原因文本**再次脱敏**（防上游漏出密钥）；
//     ③ 员工不可用时**绝不显示"运行中"**这类正面读数。
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentStatusDTO {
  /** `idle` / `assembling` / `ready` / `failed`（契约外取值也允许：**不渲染、也不崩**）。 */
  state?: string | null;
  /** 失败原因（主进程给的文本；**预期不含密钥**，渲染层仍再脱敏一次）。 */
  reason?: string | null;
  credentialSource?: string | null;
  modelRef?: string | null;
  elapsedMs?: number | null;
}

/** 行内疑似密钥（与主进程 `redactArgsDigest` 同族口径）：`sk-…` / `Bearer …` / JWT 形。 */
const INLINE_SECRET = /(sk-[A-Za-z0-9_-]{6,}|Bearer\s+[A-Za-z0-9._-]{6,}|eyJ[A-Za-z0-9._-]{10,})/g;

/** 展示前再脱敏一次（**渲染层绝不把疑似密钥写进 DOM**）。 */
export function maskSecrets(text: string): string {
  return text.replace(INLINE_SECRET, '«redacted»');
}

export interface AgentBanner {
  /** 语气：错误（不可用）。 */
  tone: 'error';
  /** 一行标题（可点开看原因）。 */
  title: string;
  /** 原因文本（已脱敏）。 */
  detail: string;
}

const CREDENTIAL_HINT = /凭据|credential|no_credential|API_KEY|secrets/i;

/**
 * 由运行时状态得到「横幅」；**只有 `failed` 出横幅**，其余（含缺省/未知）返回 `null`。
 */
export function agentBannerOf(status: AgentStatusDTO | null | undefined): AgentBanner | null {
  if (!status || typeof status.state !== 'string' || status.state !== 'failed') return null;
  const reason = typeof status.reason === 'string' && status.reason.length > 0 ? status.reason : '';
  const title = CREDENTIAL_HINT.test(reason) ? '未配置凭据 → 员工不可用' : '员工运行时不可用';
  return {
    tone: 'error',
    title,
    detail: maskSecrets(reason.length > 0 ? reason : '（主进程未提供原因）'),
  };
}
