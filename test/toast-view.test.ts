/**
 * 应用内通知浮层（2026-10-17 真机反馈「没通知」）：
 * ① 纯模型有上限/可关闭；② 空态不渲染；③ 有通知时标题/正文/关闭钮上屏；
 * ④ 样式是右下角固定浮层；⑤ 主进程真接了 AUMID 与 `evt:toast`（OS 通知之外的可见回执）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { appendToast, removeToast, TOAST_LIMIT, type ToastDTO } from '../src/renderer/components/toastModel.js';
import { ToastHost } from '../src/renderer/components/ToastHost.js';

const css = readFileSync('src/renderer/styles.css', 'utf8');
const main = readFileSync('src/main/index.ts', 'utf8');

function toast(id: number): ToastDTO {
  return { id, title: `标题${id}`, text: `正文${id}` };
}

test('浮层模型：追加保留最新 N 条；关闭只删指定 id；越界关闭不抛', () => {
  let list: ToastDTO[] = [];
  for (let i = 1; i <= TOAST_LIMIT + 2; i += 1) list = appendToast(list, toast(i));
  assert.deepEqual(list.map((t) => t.id), [3, 4, 5], `上限 ${TOAST_LIMIT}（留最新）`);
  assert.deepEqual(removeToast(list, 4).map((t) => t.id), list.filter((t) => t.id !== 4).map((t) => t.id));
  assert.deepEqual(removeToast(list, 999).map((t) => t.id), list.map((t) => t.id), '不存在的 id 原样返回');
});

test('浮层视图：空态不渲染；有通知时标题/正文/关闭钮上屏', () => {
  const empty = renderToStaticMarkup(createElement(ToastHost, { items: [], onDismiss: () => undefined }));
  assert.equal(empty, '', '无通知 → 不渲染空壳');
  const html = renderToStaticMarkup(createElement(ToastHost, { items: [toast(1)], onDismiss: () => undefined }));
  assert.match(html, /data-testid="toast-host"/);
  assert.match(html, /标题1/);
  assert.match(html, /正文1/);
  assert.match(html, /data-testid="toast-close"/);
  assert.match(html, /aria-live="polite"/);
});

test('浮层样式：右下角固定、状态条之上、限宽（不遮挡整屏）', () => {
  assert.match(css, /\.toast-host\s*\{[^}]*position:\s*fixed/s);
  assert.match(css, /\.toast-host\s*\{[^}]*right:\s*16px/s);
  assert.match(css, /\.toast-host\s*\{[^}]*bottom:\s*40px/s);
  assert.match(css, /\.toast-host\s*\{[^}]*z-index:\s*80/s);
  assert.match(css, /\.toast-host\s*\{[^}]*width:\s*min\(360px,\s*calc\(100vw - 32px\)\)/s);
});

test('主进程：Windows 设 AppUserModelID；desktop 投递同时推 evt:toast（OS 之外的可见回执）', () => {
  // 2026-10-29：AUMID 改为稳定常量（路径型 AUMID 无法稳定登记，toast 会被系统静默丢弃）。
  assert.match(main, /process\.platform === 'win32'[^\n]*setAppUserModelId\(AICO_APP_USER_MODEL_ID\)/);
  assert.match(main, /evtSink\.push\(\s*'evt:toast'/);
  assert.match(main, /Notification\.isSupported\(\)/);
});
