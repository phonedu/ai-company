/**
 * D-2 startup 守卫：模型目录预热的时机。
 * 口径：启动 DB 初始化块不得同步调用 loadModelCatalog（Pi SDK 动态 import 会抢首帧主线程）；
 * 必须移到 `ui:mounted` 之后延迟，且首次建任务前补加载，避免幕僚长选型退化。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('D-2: 启动 DB 块不预热模型目录；预热在 ui:mounted 后延迟', () => {
  const src = readFileSync('src/main/index.ts', 'utf8');
  const start = src.indexOf("setFallbackChain(readSetting(db, 'models.fallback_chain'))");
  const end = src.indexOf('// 主题（light/dark/system）');
  assert.ok(start > 0 && end > start, '启动 DB 块定位失败');
  assert.doesNotMatch(src.slice(start, end), /loadModelCatalog\(/, '启动块不得同步预热模型目录');
  assert.match(src, /catalogPreheatStarted/, '必须有预热去重标记');
  assert.match(src, /setTimeout\(\(\) => \{\s*void loadModelCatalog\(\)/, '预热必须在 ui:mounted 后延迟启动');
});

test('D-22: 首次建任务前补加载模型目录（启动延后不退化幕僚长选型）', () => {
  const src = readFileSync('src/main/ipc/ipc.ts', 'utf8');
  const start = src.indexOf('export async function handleTaskCreate');
  assert.ok(start > 0, 'handleTaskCreate 定位失败');
  const head = src.slice(start, start + 2200);
  assert.match(head, /Promise\.race\(\[/, '建任务前应以有界等待加载模型目录');
  assert.match(head, /loadModelCatalog\(\)\.catch/, '建任务前应尝试加载模型目录');
  assert.match(head, /setTimeout\(resolve, 2000\)/, '加载必须有 2s 上限，不能无限挂住建任务');
});
