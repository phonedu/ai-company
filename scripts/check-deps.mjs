#!/usr/bin/env node
// scripts/check-deps.mjs — 依赖白名单守卫
//
// 目 的：任何时刻都保证 package.json 的 dependencies/devDependencies 只包含
//        `HANDOVER §3.4` 白名单 + 已批准的派生/必备包；出现「多余」或「缺失」即非 0 退出。
//
// 用 途：接进 `pnpm test`（见 package.json `test` 脚本）与将来的 CI。
//        为什么用内置清单而不是解析 docs/HANDOVER.md：文档是散文，解析脆弱；这里内置并把
//        「来源」写清楚，改依赖时同步改这里 + `HANDOVER §3.4`（保持二者一致）。
//
// 背景：T0.1 首次安装时 `with-node22.ps1` 的单参数 bug 把 `install` 拆成
//       `i n s t a l l`，pnpm 把 `i` 当 install 命令、把 `n s t a l l` 当包名，
//       于是幽灵包 `a/l/n/s/t` 被装进 package.json。此守卫用于**回归防护**。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));

/** 白名单（HANDOVER §3.4 技术选型）+ 已批准派生/必备包。 */
const ALLOWED = new Set([
  // —— 白名单直列 ——
  'electron',
  'react',
  'react-dom',
  'typescript',
  'electron-vite',
  'valtio',
  'better-sqlite3',
  '@earendil-works/pi-coding-agent', // T0.4：精确 pin 1.1.0
  '@earendil-works/pi-ai', // T0.4：TypeBox schema 直依赖（pnpm 严格布局下间接依赖不可直接 import）
  'electron-builder', // 打包用
  'electron-updater', // GitHub 自动更新（2026-11-06 D5 后；MIT，仅打包版启用）
  // —— 已批准的派生/必备包（T0.1 依赖申报，批准）——
  'vite', // electron-vite 的 peerDependency
  '@types/node',
  '@types/react',
  '@types/react-dom',
  '@types/better-sqlite3',
  // —— UI 桥接（2026-10-18 批准，方案 B：shadcn 行为件 + Tailwind）——
  'tailwindcss',
  '@tailwindcss/vite',
  'clsx',
  'tailwind-merge',
  'class-variance-authority',
  '@radix-ui/react-dialog',
  'cmdk',
  'sonner',
  'qrcode', // 官方微信 B 扫码登录的二维码渲染（MIT；2026-10-20 随官方运输落地）
  // —— K1 知识库 Markdown 编辑器（老板 2026-10-27 选定 Milkdown；MIT）——
  '@milkdown/kit',
  '@milkdown/react',
  '@milkdown/crepe',
  // 注意：`@vitejs/plugin-react` 已批准「暂不装」；将来要装需重新上报并同步本清单。
]);

/** 必须有（防「悄悄丢依赖」；不含尚未到 T0.4 的 pi-coding-agent，也不含打包用的 builder 之外的项）。 */
const REQUIRED = new Set([
  'react',
  'react-dom',
  'valtio',
  'better-sqlite3',
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-ai',
  'electron',
  'electron-vite',
  'vite',
  'electron-builder',
  'typescript',
  '@types/node',
  '@types/react',
  '@types/react-dom',
]);

const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
const names = Object.keys(deps).sort();

const extra = names.filter((name) => !ALLOWED.has(name));
const missing = [...REQUIRED].filter((name) => !(name in deps)).sort();

if (extra.length > 0 || missing.length > 0) {
  console.error('[deps] FAIL — package.json 依赖与白名单不一致（HANDOVER §3.4）');
  if (extra.length > 0) console.error(`[deps]   多余（不在白名单）: ${extra.join(', ')}`);
  if (missing.length > 0) console.error(`[deps]   缺失（应有但没有）: ${missing.join(', ')}`);
  process.exit(1);
}

console.log(`[deps] ok — ${names.length} 个依赖均在白名单 + 已批准派生包内`);
