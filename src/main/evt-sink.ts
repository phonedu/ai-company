/**
 * evt-sink（最小版， Q-B / §7.3.1）
 *
 * 把主进程产生的事件按 **16ms 窗口**合并成统一信封推给渲染层：
 *   `{ channel, batchSeq, items[], emitAt }`（每批 ≤ `maxPerBatch`，超出拆多批；`emitAt` 供 P-09 延迟采样）。
 * 批内同 `key` 的条目 **last-wins**（同窗口同一主体只留最新）；无 key 的条目不去重。
 *
 *  只做最小版：**不含 `truncated` 标记与完整背压**（留）。
 * 纯逻辑、不依赖 Electron，便于单测（test/evt-sink.test.ts）。
 */

export interface EvtBatchEnvelope {
  channel: string;
  batchSeq: number;
  items: unknown[];
  /** P-09：主进程发出该次的 epoch ms（渲染层收包减它＝主→渲染延迟）。 */
  emitAt: number;
}

/** 推送目标（主进程里就是 `webContents`；测试里是一个记录器）。 */
export interface EvtSinkTarget {
  send(channel: string, payload: unknown): void;
  isDestroyed?(): boolean;
}

export interface EvtSinkStats {
  batches: number;
  items: number;
  coalesced: number;
}

export class EvtSink {
  private readonly pending = new Map<string, Map<string, unknown>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  private keyCounter = 0;
  private readonly counters: EvtSinkStats = { batches: 0, items: 0, coalesced: 0 };
  private readonly batchSizes: number[] = [];
  /** F-G8：每通道「最新一批」缓存 —— 供订阅时回放（补上**订阅前**发生的事件，如启动期装配失败）。 */
  private readonly lastByChannel = new Map<string, unknown[]>();

  constructor(
    private readonly targetProvider: () => EvtSinkTarget | null,
    private readonly windowMs = 16,
    private readonly maxPerBatch = 500,
  ) {}

  /** 入队一个条目；给了 `key` 则同窗口内 last-wins。 */
  push(channel: string, item: unknown, key?: string): void {
    let bucket = this.pending.get(channel);
    if (!bucket) {
      bucket = new Map<string, unknown>();
      this.pending.set(channel, bucket);
    }
    const effectiveKey = key ?? `#${this.keyCounter++}`;
    if (bucket.has(effectiveKey)) this.counters.coalesced += 1;
    bucket.set(effectiveKey, item);

    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.windowMs);
      this.timer.unref?.();
    }
  }

  /** 立即清空并推送（窗口到期或退出前调用；bench/测试里也用）。 */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.size === 0) return;

    // F-G8：**先**把每通道本窗 items 存入缓存（**无论 target 是否可用** —— 订阅前产生的事件也要能回放）。
    for (const [channel, bucket] of this.pending) {
      this.lastByChannel.set(channel, [...bucket.values()]);
    }

    const target = this.targetProvider();
    if (!target || target.isDestroyed?.() === true) {
      this.pending.clear();
      return;
    }

    for (const [channel, bucket] of this.pending) {
      const items = [...bucket.values()];
      for (let offset = 0; offset < items.length; offset += this.maxPerBatch) {
        const chunk = items.slice(offset, offset + this.maxPerBatch);
        this.seq += 1;
        const envelope: EvtBatchEnvelope = { channel, batchSeq: this.seq, items: chunk, emitAt: Date.now() };
        target.send('evt:batch', envelope);
        this.counters.batches += 1;
        this.counters.items += chunk.length;
        this.batchSizes.push(chunk.length);
      }
    }
    this.pending.clear();
  }

  /** 退出前兜底（与 flush 相同，语义化命名）。 */
  dispose(): void {
    this.flush();
  }

  /** F-G8：每通道「最新一批」快照（渲染层订阅时拉一次，补齐订阅前丢失的事件）。 */
  snapshot(): Array<{ channel: string; items: unknown[] }> {
    return [...this.lastByChannel.entries()].map(([channel, items]) => ({ channel, items: [...items] }));
  }

  stats(): EvtSinkStats & { maxBatchObserved: number } {
    return { ...this.counters, maxBatchObserved: this.batchSizes.reduce((m, n) => Math.max(m, n), 0) };
  }
}
