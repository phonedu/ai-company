/**
 * `bus.ts` —— 进程内事件总线（引擎 → 渲染进程推送的单一出口）。
 *
 * 极简实现：订阅返回退订函数（与 preload 的 `on()` 形状一致，便于接线）。
 * 引擎只 emit，不关心谁在听。
 */
export type BusListener<T> = (event: T) => void;

export class EventBus<T> {
  private readonly listeners = new Set<BusListener<T>>();

  subscribe(listener: BusListener<T>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: T): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  get size(): number {
    return this.listeners.size;
  }
}
