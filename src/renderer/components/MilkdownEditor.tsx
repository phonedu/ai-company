/**
 * K1 · Milkdown Crepe 编辑器 React 包装。
 *
 * Crepe 是浏览器端库（需要 document），不能在 Node 单测——这个组件只在渲染层用。
 * 如果 Crepe 初始化失败（兼容性问题等），自动回落到 textarea（不白屏）。
 * Crepe 7.22 实测 API：`create()/destroy()/getMarkdown()/on(fn)`，**没有 setMarkdown**——
 * 设内容用 `editor.action(replaceAll(md))`（见 crepe-lazy.ts 头注）。
 */
import { createElement, ReactElement, useEffect, useRef, useState } from 'react';

/** Crepe 7.x 实例的结构面（防御式：字段缺失时回落 textarea，不白屏）。 */
interface CrepeInstance {
  create: () => Promise<unknown>;
  destroy: () => Promise<unknown>;
  getMarkdown: () => string;
  on: (fn: (listener: { markdownUpdated: (cb: (ctx: unknown, markdown: string, prev: string) => void) => unknown }) => void) => unknown;
  editor: { action: (act: (ctx: unknown) => void) => unknown };
  /** Crepe 7.x 只读开关（阅读态复用同一渲染器，不显示源码）。 */
  setReadonly?: (value: boolean) => unknown;
}

/** 2026-10-29 性能：按需读值（保存时序列化一次），避免每次按键全量 serialize。 */
export interface MilkdownApi {
  getMarkdown: () => string;
  /**
   * 2026-11-06（复核）：编辑器**自己规范化后**的初始正文。判脏必须拿它当基线——
   * 用磁盘原文比会把 Crepe 的规范化回吐（尾部换行等）误判成用户修改。
   */
  getBaseline: () => string;
}

interface MilkdownEditorProps {
  value: string;
  onChange?: (markdown: string) => void;
  /** 不传 onChange 时副作用最小：不注册 markdownUpdated（Crepe 不再逐键 serialize），保存时用 apiRef 读。 */
  apiRef?: { current: MilkdownApi | null };
  placeholder?: string;
  style?: Record<string, string | number>;
  /**
   * 只读渲染（/，2026-10-28 裁）：阅读态＝同一 Crepe 渲染器只读化——
   * **只显示渲染后的内容，不显示源码**；渲染失败时显式报错（不退回裸源码）。
   */
  readOnly?: boolean;
}

export function MilkdownEditor({ value, onChange, placeholder, style, readOnly = false, apiRef }: MilkdownEditorProps): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const crepeRef = useRef<CrepeInstance | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  /** 2026-10-29：加载失败可重试（不要求整页刷新）；重试 = 清 failed + 换 key 重挂。 */
  const [attempt, setAttempt] = useState(0);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const lastSetRef = useRef(value);
  /** 最近一次由父层传入的 value（区分「父层换文」与「Crepe 规范化回吐」，避免重复 replaceAll）。 */
  const lastExternalRef = useRef(value);
  /** 判脏基线：Crepe 规范化后的初始正文（初值回吐不算用户修改）。 */
  const baselineRef = useRef(value);

  // 初始化 Crepe（挂载时一次）
  useEffect(() => {
    if (!containerRef.current || failed) return;
    let disposed = false;
    let crepe: CrepeInstance | null = null;

    (async () => {
      try {
        const { Crepe, replaceAll } = await import('./crepe-lazy.js');
        if (disposed || !containerRef.current) return;
        crepe = new Crepe({ root: containerRef.current }) as unknown as CrepeInstance;
        // 变更监听：crepe.on 的入参是 listener 管理器，markdownUpdated 拿最新全文。
        // 2026-10-29：只有传了 onChange 才注册——否则 Crepe 会每个按键把全文序列化成
        // Markdown（100KB 实测 serializer 占 ~50ms/键），编辑大笔记时明显卡顿。
        if (typeof onChangeRef.current === 'function') try {
          crepe.on((listener) => {
            listener.markdownUpdated((_ctx, markdown) => {
              if (markdown !== lastSetRef.current) {
                lastSetRef.current = markdown;
                onChangeRef.current?.(markdown);
              }
            });
          });
        } catch { /* listener API 变化不影响编辑 */ }
        await crepe.create();
        if (disposed) { void crepe.destroy(); return; }
        // 2026-11-05（老板 T6 点验）：中文笔记里英文/编号（s13、s14…）被浏览器拼写检查画红波浪线，
        // 像"错字"且随内容滚动。Crepe 与上游都没关它 → 这里显式关掉（ProseMirror 是 contenteditable
        // 根节点，spellcheck 默认 true）。
        try {
          const editable = containerRef.current?.querySelector('.ProseMirror');
          if (editable) {
            editable.setAttribute('spellcheck', 'false');
            editable.setAttribute('autocorrect', 'off');
            editable.setAttribute('autocapitalize', 'off');
          }
        } catch { /* 属性设置失败不影响编辑 */ }
        // 阅读态只读化（工具栏/块把手随之隐藏；内容仍可由 replaceAll 注入）。
        if (readOnly) crepe.setReadonly?.(true);
        // 设初值：replaceAll 是 @milkdown/kit/utils 的 action（Crepe 7.x 无 setMarkdown）。
        crepe.editor.action(replaceAll(lastSetRef.current) as unknown as (ctx: unknown) => void);
        // 2026-11-06（终验 g3 带回 / 复核修）：Crepe 会把注入内容**规范化**后回吐
        // （如尾部换行/列表符号），与传入原文不逐字相等 → 上层判「有未保存修改」→ 退出编辑弹
        // 原生 confirm（未改一字也弹）。把规范化后的正文同时记为基线与 lastSet：
        // 初值回吐不算用户修改；父层未换文时 [value, ready] effect 也不再重复 replaceAll。
        try {
          lastSetRef.current = crepe.getMarkdown();
          baselineRef.current = lastSetRef.current;
        } catch { /* 拿不到就保持原基线（退化为旧行为，不阻塞） */ }
        crepeRef.current = crepe;
        if (apiRef) {
          apiRef.current = {
            getMarkdown: () => {
              try { return crepeRef.current?.getMarkdown() ?? lastSetRef.current; } catch { return lastSetRef.current; }
            },
            getBaseline: () => baselineRef.current,
          };
        }
        setReady(true);
      } catch (error) {
        console.warn('[MilkdownEditor] Crepe 初始化失败，回落 textarea：', error);
        if (!disposed) setFailed(true);
      }
    })();

    return () => {
      disposed = true;
      if (crepeRef.current) {
        try { void crepeRef.current.destroy(); } catch { /* ignore */ }
        crepeRef.current = null;
      }
      if (apiRef) apiRef.current = null;
    };
  }, [attempt]);

  // readOnly 变化时同步只读态（即使调用方未重建实例，也不把编辑态锁死）。
  useEffect(() => {
    if (!ready) return;
    try { crepeRef.current?.setReadonly?.(readOnly); } catch { /* ignore */ }
  }, [readOnly, ready]);

  // 外部 value 变化时同步到编辑器（不触发 onChange 防循环）。
  // 2026-11-06（复核）：只认「父层真的换了文」——initial 注入后 lastSetRef 已是规范化正文，
  // 若还拿它和 value 比，ready 翻真时会把原文再灌一遍，刚建的基线立刻失效。
  useEffect(() => {
    if (crepeRef.current && ready && value !== lastExternalRef.current) {
      lastExternalRef.current = value;
      lastSetRef.current = value;
      baselineRef.current = value;
      try {
        // 懒加载 replaceAll 需经同一门面；正常路径下编辑器已就绪，动态 import 开销可忽略。
        void import('./crepe-lazy.js').then(({ replaceAll }) => {
          if (!crepeRef.current) return;
          crepeRef.current.editor.action(replaceAll(value) as unknown as (ctx: unknown) => void);
          // 换文后的规范化结果成为新基线（阅读分章复用同一实例）。
          try {
            lastSetRef.current = crepeRef.current.getMarkdown();
            baselineRef.current = lastSetRef.current;
          } catch { /* 保持注入原文 */ }
        }).catch(() => { /* 同步失败不传播 */ });
      } catch { /* ignore */ }
    }
  }, [value, ready]);

  // 失败回落（2026-10-29 编辑态同口径）：**任何状态都不退回裸源码**——
  // 2026-10-28：「编辑态和阅读的时候都不显示源码」。失败=显式报错 + 可重试。
  if (failed) {
    return createElement('div', {
      'data-testid': readOnly ? 'milkdown-readonly-failed' : 'milkdown-edit-failed',
      role: 'alert',
      style: { padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8, margin: 0 },
    },
      createElement('p', { style: { fontSize: 13, color: 'var(--text-dim)', margin: 0 } },
        readOnly
          ? '内容渲染失败（富文本渲染器未就绪）。为避免展示源码，这里不显示原始文本。'
          : '编辑器加载失败（富文本渲染器未就绪）。为避免展示源码，这里不退回纯文本；可重试。'),
      createElement('button', {
        type: 'button',
        'data-testid': readOnly ? 'milkdown-readonly-retry' : 'milkdown-edit-retry',
        onClick: () => {
          setFailed(false);
          setReady(false);
          setAttempt((n) => n + 1);
        },
        style: { alignSelf: 'flex-start', fontSize: 12, padding: '2px 10px', cursor: 'pointer' },
      }, '重试'),
    );
  }

  // 正常渲染：Crepe 容器
  // （真机批）：容器必须自己可滚——外层链全是 overflow:hidden，编辑内容超高时
  // 滚轮无处作用＝长文档下半部永远看不见（新建弹层固定高度时尤其致命）。
  return createElement('div', {
    'data-testid': readOnly ? 'milkdown-readonly' : 'milkdown-editor',
    'data-ready': ready ? 'true' : 'false',
    'data-readonly': readOnly ? 'true' : 'false',
    ref: containerRef,
    style: { minHeight: 120, overflowY: 'auto', ...style },
  });
}
