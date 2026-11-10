import { Fragment } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import { useSnapshot } from 'valtio';

import { inbox, session, showArchive, showChannel, showHall, showInbox, showNotes, showProjectTree, showSettings } from '../store';
import { NavIcon, type NavIconName } from './icons.js';

// ─────────────────────────────────────────────────────────────────────────────
// LeftRail（UI §1：**左栏是唯一导航**）——固定入口（纯导航）。
//   2026-10-17（决定「左栏最下面的任务展示直接不要算了」＋「建任务放哪」的第二步）：
//   **任务列表退役**（任务在项目树页右栏 / 归档页 / 命令面板），**建任务区也退役**
//   （改由「老板频道输入框旁 ＋建任务」与「项目树页右栏页头 ＋建任务」两个上下文入口）。
//   左栏只剩：六个导航项 ＋ 待我处理未读徽标。
// ─────────────────────────────────────────────────────────────────────────────

/** 左栏固定入口（UI §1）：主 3（待我处理 / 老板频道 / 项目树）＋次 3（公司大厅 / 归档 / 设置）。 */
const NAV_SECTIONS: ReadonlyArray<{
  label: string;
  testid: string;
  icon: NavIconName;
  channel?: boolean;
  hall?: boolean;
  inbox?: boolean;
  archive?: boolean;
  projects?: boolean;
  settings?: boolean;
  notes?: boolean;
  /** 次级入口：更低层级；`groupStart` 的第一项前插分隔线与「更多」标题。 */
  secondary?: boolean;
  groupStart?: boolean;
}> = [
  { label: '待我处理', testid: 'leftrail-inbox', icon: 'inbox', inbox: true },
  { label: '老板频道', testid: 'leftrail-channel', icon: 'channel', channel: true },
  { label: '项目树', testid: 'leftrail-projects', icon: 'projects', projects: true },
  { label: '笔记', testid: 'leftrail-notes', icon: 'inbox', notes: true },
  { label: '公司大厅', testid: 'leftrail-hall', icon: 'hall', hall: true, secondary: true, groupStart: true },
  { label: '归档', testid: 'leftrail-archive', icon: 'archive', archive: true, secondary: true },
  { label: '设置', testid: 'leftrail-settings', icon: 'settings', settings: true, secondary: true },
];

const NAV_ACTIVE_STYLE: CSSProperties = {
  background: 'var(--tint-soft)', color: 'var(--accent-ink)',
  fontWeight: 600,
};

export function LeftRail(): ReactElement {
  const sessionSnap = useSnapshot(session);
  const inboxSnap = useSnapshot(inbox);
  // 1c：未读数来自服务端 `channel:cards` 游标；未加载 → 不显示；
  // 已加载但读数失败 → 显 `—`（不写假 0、不隐藏成“已清零”）。
  const inboxUnread = inboxSnap.unread;
  const inboxUnknown = inboxSnap.loaded && inboxSnap.unreadState === 'unknown';

  return (
    <nav className="left-rail" data-testid="left-rail" aria-label="主导航">
      <div className="left-rail__nav" data-testid="left-rail-nav">
        {NAV_SECTIONS.map((section) => {
          const active =
            (section.channel === true && sessionSnap.view === 'channel') ||
            (section.hall === true && sessionSnap.view === 'hall') ||
            (section.inbox === true && sessionSnap.view === 'inbox') ||
            (section.archive === true && sessionSnap.view === 'archive') ||
            (section.projects === true && sessionSnap.view === 'projects') ||
            (section.notes === true && sessionSnap.view === 'notes') ||
            (section.settings === true && sessionSnap.view === 'settings');
          const onClick =
            section.channel === true
              ? showChannel
              : section.hall === true
                ? showHall
                : section.inbox === true
                  ? showInbox
                  : section.archive === true
                    ? showArchive
                    : section.projects === true
                      ? showProjectTree
                      : section.notes === true
                        ? showNotes
                        : section.settings === true
                        ? showSettings
                        : undefined;
          const implemented = onClick !== undefined;
          const unread = section.inbox === true ? inboxUnread : 0;
          return (
            <Fragment key={section.label}>
              {section.groupStart === true ? (
                <>
                  <div className="left-rail__sep" aria-hidden="true" />
                  <div className="left-rail__caption">更多</div>
                </>
              ) : null}
              <button
                type="button"
                className={`left-rail__item${section.secondary === true ? ' left-rail__item--secondary' : ''}`}
                data-testid={section.testid}
                aria-current={active ? 'page' : undefined}
                disabled={!implemented}
                aria-disabled={!implemented}
                title={implemented ? undefined : '未实现（M1）'}
                style={active ? NAV_ACTIVE_STYLE : undefined}
                onClick={onClick}
              >
                {/* 壳层重排 v4：线性图标（内联 SVG，`icons.tsx`）＋标签；折叠态（56px）只留图标。 */}
                <NavIcon name={section.icon} />
                <span className="left-rail__label">{section.label}</span>
                {section.inbox === true && inboxUnknown ? (
                  <span className="left-rail__badge" data-testid="leftrail-inbox-badge" title="未读读数不可用">
                    —
                  </span>
                ) : typeof unread === 'number' && unread > 0 ? (
                  <span className="left-rail__badge" data-testid="leftrail-inbox-badge">
                    {unread}
                  </span>
                ) : null}
              </button>
            </Fragment>
          );
        })}
      </div>
    </nav>
  );
}
