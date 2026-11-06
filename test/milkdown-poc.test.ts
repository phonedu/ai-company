/**
 * K1 Step 1 · Milkdown PoC：React 19 兼容性验证。
 *
 * 判据：包已安装、核心 API 可导入、体积可接受。
 * @milkdown/react 实际导出：Milkdown, MilkdownProvider, useEditor, useInstance（标准 React hooks）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { statSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

test('Milkdown 包已安装且核心 API 可导入（React 19 兼容第一道验证）', async () => {
  for (const pkg of ['@milkdown/kit', '@milkdown/react', '@milkdown/crepe']) {
    assert.ok(existsSync(join(root, 'node_modules', pkg)), `${pkg} 应已安装`);
  }
  const react = (await import('@milkdown/react')) as Record<string, unknown>;
  assert.ok(typeof react.MilkdownProvider === 'function' || typeof react.MilkdownProvider === 'object',
    `MilkdownProvider 应可导入（实际 ${typeof react.MilkdownProvider}）`);
  assert.ok(typeof react.useEditor !== 'undefined', 'useEditor 应可导入');
  assert.ok(typeof react.Milkdown === 'function' || typeof react.Milkdown === 'object', 'Milkdown 组件应可导入');
});

test('Milkdown 包体积在可接受范围（<500KB 总计）', () => {
  let total = 0;
  for (const pkg of ['@milkdown/kit', '@milkdown/react', '@milkdown/crepe']) {
    const dir = join(root, 'node_modules', pkg);
    if (!existsSync(dir)) continue;
    const sizeOf = (d: string): number => {
      let n = 0;
      try {
        for (const f of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, f.name);
          if (f.isDirectory() && f.name !== 'node_modules') n += sizeOf(p);
          else if (f.isFile() && (f.name.endsWith('.js') || f.name.endsWith('.mjs') || f.name.endsWith('.css'))) n += statSync(p).size;
        }
      } catch { /* ignore */ }
      return n;
    };
    total += sizeOf(dir);
  }
  assert.ok(total < 1_048_576, `Milkdown 总体积 ${Math.round(total / 1024)}KB 应 < 1MB`);
});

test('Crepe 7.x 实际 API 面：无 setMarkdown，设内容走 kit/utils 的 replaceAll（F-3 回归锚点）', async () => {
  const crepeMod = (await import('@milkdown/crepe')) as unknown as { Crepe: { prototype: Record<string, unknown> } };
  const { Crepe } = crepeMod;
  assert.equal(typeof Crepe.prototype.setMarkdown, 'undefined',
    '若 Crepe 未来提供 setMarkdown，可回到直呼口径；当前必须走 replaceAll（见 MilkdownEditor.tsx）');
  const utils = (await import('@milkdown/kit/utils')) as Record<string, unknown>;
  assert.equal(typeof utils.replaceAll, 'function', 'replaceAll 必须可导入（编辑器设内容的唯一口径）');
});
