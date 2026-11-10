/**
 * SplitLayout · 主从两栏统一组件（2026-11-03 要求方案）。
 *
 * 为什么有它：设置（190）/项目树（300）/公司大厅（300）/笔记（340）四页各写各的分栏 CSS，
 * 窄窗行为漂移——大厅 34vh 拦腰截断、设置右栏顶出窗体、笔记无处理。本组件一处实现：
 *  - **宽窗（>1040px）**：左右并排，左列固定 `sideWidth`（维持各页现状，不做拖动——
 *    左栏主导航本就可折叠到 56px 腾空间，拖动后期另批）。
 *  - **窄窗（≤1040px）**：上下堆叠，左列变折叠头（▸/▾ 列表（N 项）），交互语言与顶栏
 *    折叠钮一致；展开高度给足滚动，**不设 34vh 截断**。折叠态按 `storageKey` 记忆
 *    （localStorage，同壳 `railCollapsed` 模式）。
 *
 * 断点真源：`NARROW_QUERY` 从本文件导出（壳层 AppShell 复用）——壳层右栏自动收起、
 *  批 CSS media query、本组件共用同一个定义，不再各写各的。
 */
import { createElement, MouseEvent as ReactMouseEvent, ReactElement, ReactNode, useEffect, useRef, useState } from 'react';

/** 窄窗断点（设计件 §1：1040 以下右栏自动收起；2026-11-03 起也是页内分栏堆叠点）。 */
export const NARROW_QUERY = '(max-width: 1040px)';

export function isNarrowViewport(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(NARROW_QUERY).matches
  );
}

/** 订阅窄窗断点变化（SSR/测试无 window → 恒 false，由 `stackedOverride` 控）。 */
export function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(isNarrowViewport);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(NARROW_QUERY);
    const onChange = (): void => setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

/** 折叠态持久化（纯函数可测；storage 缺失/坏值 → 缺省折叠）。 */
export function readStackedCollapsed(storageKey: string, storage: Pick<Storage, 'getItem'> | null): boolean {
  if (storage == null) return true;
  try {
    return storage.getItem(`aico:split:${storageKey}:collapsed`) !== '0';
  } catch {
    return true;
  }
}

export function writeStackedCollapsed(storageKey: string, collapsed: boolean, storage: Pick<Storage, 'getItem' | 'setItem'> | null): void {
  if (storage == null) return;
  try {
    storage.setItem(`aico:split:${storageKey}:collapsed`, collapsed ? '1' : '0');
  } catch { /* 隐私模式等写不进 → 不记忆，不影响功能 */ }
}

export interface SplitLayoutProps {
  /** 左列内容（列表/导航）。窄窗折叠头控制的就是它。 */
  side: ReactNode;
  /** 主内容。窄窗堆叠时整宽。 */
  main: ReactNode;
  /** 宽窗左列宽度（px）：设置 190／项目 300／大厅 300／笔记 340。 */
  sideWidth: number;
  /** 左列称呼（折叠头文案：「列表」／「导航」…）。 */
  label: string;
  /** 折叠记忆键（按页区分，如 'hall'）。 */
  storageKey: string;
  /** 左列条目数（折叠头显示「列表（N 项）」；缺省不显示计数）。 */
  count?: number;
  /** 测试注入口（缺省跟 matchMedia 走）。 */
  stackedOverride?: boolean;
  /** 测试注入口：折叠态存储（缺省 localStorage）。 */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** 2026-11-04 笔记批：主内容暂无（如笔记未选中条目）→ 左列独占整宽，不折叠不堆叠
   *  （与改造前「列表 flex:1」行为一致；选中后恢复常规分栏/堆叠）。 */
  hideMain?: boolean;
  /** 2026-11-04 老板意见：窄窗抽屉里点选条目后自动收起（浮层不压住主内容）。
   *  缺省开启；表单控件（input/select/textarea/label）不触发收起（保护批量勾选）。 */
  keepOpenOnSideClick?: boolean;
}

export function SplitLayout(props: SplitLayoutProps): ReactElement {
  const mediaNarrow = useNarrowViewport();
  const stacked = props.stackedOverride ?? mediaNarrow;
  const storage = props.storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
  const [collapsed, setCollapsed] = useState(() => readStackedCollapsed(props.storageKey, storage));

  // T1 交互专项（口径）：抽屉＝弹层，Esc 必须能关（与建任务/新建笔记弹层同语言）。
  useEffect(() => {
    if (!stacked || collapsed) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setCollapsed(true);
        writeStackedCollapsed(props.storageKey, true, storage);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [stacked, collapsed]);

  // 老板意见（2026-11-04）：从 solo（未选中，列表独占）点选条目切回分栏时——
  // 自动收起抽屉，让主内容先露脸（这就是「选中以后自动折叠」）。
  // T3-③（对抗审查）：didMount 守卫——只在 hideMain true→false 翻转时收起；
  // 否则首挂载即覆写 storage，折叠记忆（按 storageKey 记住）永不生效。
  const prevHideMain = useRef(props.hideMain === true);
  useEffect(() => {
    const was = prevHideMain.current;
    prevHideMain.current = props.hideMain === true;
    if (was || props.hideMain) return;
    setCollapsed(true);
    writeStackedCollapsed(props.storageKey, true, storage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.hideMain]);

  const toggle = (): void => {
    const next = !collapsed;
    setCollapsed(next);
    writeStackedCollapsed(props.storageKey, next, storage);
  };

  if (props.hideMain) {
    // 主内容暂无：左列独占整宽（等价旧「列表 flex:1」），无折叠头、无堆叠。
    return createElement('div', { className: 'split split--solo', 'data-testid': `split-${props.storageKey}` },
      createElement('div', { className: 'split__main' }, props.side),
    );
  }
  if (!stacked) {
    return createElement('div', { className: 'split', 'data-testid': `split-${props.storageKey}` },
      createElement('aside', { className: 'split__side', style: { flex: `0 0 ${props.sideWidth}px` } }, props.side),
      createElement('div', { className: 'split__main' }, props.main),
    );
  }
  // 2026-11-04 老板意见：折叠头压内容难看 → 悬浮抽屉。主内容整宽常驻；
  // 悬浮按钮开合抽屉（浮层在主内容之上）；抽屉内点选条目自动收起（表单控件除外）。
  const drawerId = `split-${props.storageKey}-drawer`;
  const onSideClickCapture = (e: ReactMouseEvent): void => {
    if (props.keepOpenOnSideClick) return;
    const t = e.target as HTMLElement | null;
    if (t != null && typeof t.closest === 'function' && t.closest('input, select, textarea, label, [data-split-keep]')) return;
    setCollapsed(true);
    writeStackedCollapsed(props.storageKey, true, storage);
  };
  return createElement('div', { className: 'split split--stacked', 'data-stacked': 'true', 'data-testid': `split-${props.storageKey}` },
    createElement('div', { className: 'split__main' }, props.main),
    createElement('button', {
      type: 'button',
      className: collapsed ? 'split__fab' : 'split__fab split__fab--open',
      'data-testid': `split-${props.storageKey}-toggle`,
      'aria-expanded': collapsed ? 'false' : 'true',
      'aria-controls': drawerId,
      onClick: toggle,
    }, `${collapsed ? '☰' : '✕'} ${props.label}${props.count != null && collapsed ? `（${props.count}）` : ''}`),
    collapsed ? null : createElement('div', { className: 'split__overlay' },
      createElement('div', { className: 'split__scrim', 'data-testid': `split-${props.storageKey}-scrim`, onClick: toggle }),
      createElement('aside', {
        className: 'split__drawer',
        id: drawerId,
        'data-testid': `split-${props.storageKey}-drawer`,
        onClick: onSideClickCapture,
      }, props.side),
    ),
  );
}
