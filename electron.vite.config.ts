import tailwindcss from '@tailwindcss/vite';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

/**
 * electron-vite 三段入口：main / preload / renderer。
 *
 * 关键决策（T0.1）：
 * - 本仓库 `package.json` 为 `"type": "module"`（`src/core` 的单测以 ESM 编译运行），
 *   但 Electron 的 **sandbox: true 的 preload 不支持 ESM**（DEV §7.4 明确要求 sandbox），
 *   且主进程用 CJS 最稳（`__dirname`、原生模块 `better-sqlite3` 加载路径一致）。
 *   因此把 main / preload 显式打成 **CJS + `.cjs` 扩展名**，绕开 ESM 的 ABI/入口坑。
 * - renderer 由 Vite 构建（浏览器 ESM），JSX 用自动运行时（不引 @vitejs/plugin-react）。
 */
const cjsOutput = {
  format: 'cjs' as const,
  entryFileNames: '[name].cjs',
  chunkFileNames: '[name].cjs',
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { output: cjsOutput },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { output: cjsOutput },
    },
  },
  renderer: {
    plugins: [tailwindcss()],
    esbuild: { jsx: 'automatic' },
  },
});
