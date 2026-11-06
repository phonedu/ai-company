/**
 * E-16 幕僚长卡片升级：三张幕僚长卡（招募/档案变更/技能提议）＋选项控件。
 *
 * 设计口径（界面 / 员工 / 待办口径（E-16））：
 * - 卡片类型**始终只有四类**（受理/决策/汇报/异常），幕僚长卡走既有形式，不新增第五类
 * - 招募卡 → `kind:'notification'`（默认自招模式：通知+可改，不阻塞）
 * - 档案变更卡 → `kind:'notification'`（通知审计）
 * - 技能提议卡 → `kind:'ask'`（决策卡：需老板批准入库）
 * - 选项控件 → AskCard options 已支持 key/label；扩展 `multi` 标记支持多选
 */
import type { SqliteDb } from '../db/open.js';
import { notify } from '../notify/index.js';

// ── 类型 ─────────────────────────────────────────

export interface RecruitCardData {
  employeeId: number;
  employeeName: string;
  role: string;
  persona: string;
  model: string;
  skills: string[];
  tier: string;
  taskId: number;
  taskShortId: string;
  /** 自招（默认）＝通知不阻塞；招募需批准＝决策卡 */
  blocking: boolean;
}

export interface ProfileChangeCardData {
  employeeId: number;
  employeeName: string;
  /** 改了哪些字段 */
  changes: Array<{ field: string; oldValue: string; newValue: string }>;
  /** 谁改的 */
  changedBy: 'boss' | 'assistant';
  taskId: number | null;
}

export interface SkillProposalCardData {
  /** 技能名 */
  name: string;
  /** 技能描述 */
  description: string;
  /** 技能内容（SKILL.md 摘要） */
  content: string;
  /** 来源：哪个任务沉淀的 */
  sourceTaskId: number;
  sourceTaskShortId: string;
}

// ── 卡片生成器 ────────────────────────────────────

/** 招募卡：幕僚长自动招募后发一张「新员工档案」通知卡（默认非阻塞）。 */
export function sendRecruitCard(db: SqliteDb, data: RecruitCardData): void {
  const skills = data.skills.length > 0 ? data.skills.join('、') : '（无）';
  const body = [
    `**${data.employeeName}** · ${data.role}`,
    `人设：${data.persona.slice(0, 100)}${data.persona.length > 100 ? '…' : ''}`,
    `模型：${data.model} · 档位：${data.tier}`,
    `技能：${skills}`,
    `任务：${data.taskShortId}`,
  ].join('\n');

  notify(db, {
    taskId: data.taskId,
    kind: data.blocking ? 'ask' : 'notification',
    dedupeKey: `recruit-card:${data.employeeId}:${data.taskId}`,
    payload: {
      title: `已招募「${data.employeeName}」· ${data.role}`,
      body,
      card: 'recruit',
      employeeId: data.employeeId,
      employeeName: data.employeeName,
      role: data.role,
      model: data.model,
      tier: data.tier,
      skills: data.skills,
      options: data.blocking
        ? [
            { key: 'confirm', label: '确认入职' },
            { key: 'adjust', label: '调整档案' },
            { key: 'reject', label: '撤销招募' },
          ]
        : undefined,
    },
    now: Date.now(),
  });
}

/** 档案变更卡：persona/技能/模型等被改后发一张审计通知卡。 */
export function sendProfileChangeCard(db: SqliteDb, data: ProfileChangeCardData): void {
  const changes = data.changes
    .map((c) => `- **${c.field}**：${c.oldValue || '（空）'} → ${c.newValue || '（空）'}`)
    .join('\n');
  const changedByLabel = data.changedBy === 'boss' ? '老板' : '幕僚长';

  notify(db, {
    taskId: data.taskId,
    kind: 'notification',
    dedupeKey: `profile-change:${data.employeeId}:${Date.now()}`,
    payload: {
      title: `员工档案已更新「${data.employeeName}」`,
      body: `由${changedByLabel}修改：\n${changes}`,
      card: 'profile-change',
      employeeId: data.employeeId,
      changes: data.changes,
    },
    now: Date.now(),
  });
}

/** 技能提议卡：幕僚长建议把任务经验固化为技能（决策卡：需批准）。 */
export function sendSkillProposalCard(db: SqliteDb, data: SkillProposalCardData): void {
  notify(db, {
    taskId: data.sourceTaskId,
    kind: 'ask',
    dedupeKey: `skill-proposal:${data.name}:${data.sourceTaskId}`,
    payload: {
      title: `提议新技能「${data.name}」`,
      body: [
        `**描述**：${data.description}`,
        '',
        `**内容摘要**：`,
        data.content.slice(0, 300) + (data.content.length > 300 ? '…' : ''),
        '',
        `来源任务：${data.sourceTaskShortId}`,
      ].join('\n'),
      card: 'skill-proposal',
      skillName: data.name,
      sourceTaskId: data.sourceTaskId,
      options: [
        { key: 'approve', label: '批准入库' },
        { key: 'deny', label: '不需要' },
      ],
    },
    now: Date.now(),
  });
}

// ── 选项控件扩展 ──────────────────────────────────

/**
 * 扩展 AskCard options：支持多选（`multi: true`）。
 * 现有 options 格式不变（key/label）；加 `multi` 标记后 UI 渲染为 checkbox 组。
 */
export interface CardOption {
  key: string;
  label: string;
  /** 多选模式下此选项是否默认勾选 */
  checked?: boolean;
}

export interface MultiSelectOptions {
  /** 多选模式标记 */
  multi: true;
  options: CardOption[];
  /** 最多可选几个（缺省不限） */
  max?: number;
}

/** 判断 AskCard payload 的 options 是否为多选模式。 */
export function isMultiSelectOptions(payload: { options?: unknown }): payload is { options: MultiSelectOptions } {
  const opts = payload.options as MultiSelectOptions | undefined;
  return opts != null && typeof opts === 'object' && opts.multi === true && Array.isArray(opts.options);
}
