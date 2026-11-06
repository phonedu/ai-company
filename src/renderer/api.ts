// 渲染层获取 preload API 的唯一入口。
//
// 生产：`window.api`（contextBridge 暴露）。
// 测试/自测：可用 `globalThis.__AICO_API__` 注入一个**计数假实现**——contextBridge 暴露的对象
// 一般不可重写，故留这个受控 seam，专用于 T0.5 的「一次点击 = 恰好一条 IPC」断言。
export function getApi(): AicoPreloadApi | undefined {
  const injected = (globalThis as typeof globalThis & { __AICO_API__?: AicoPreloadApi }).__AICO_API__;
  return injected ?? window.api;
}
