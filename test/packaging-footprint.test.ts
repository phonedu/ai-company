/**
 * P-1（尾）：Pi 足迹裁剪守卫——只排除 DeepSeek-only 用法下永不加载的 provider SDK；
 * **绝不排除** `@earendil-works/**`（loader/provider）与 `openai`（DeepSeek 经 openai-completions 走它）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const yml = readFileSync('electron-builder.yml', 'utf8');
const filesBlock = yml.slice(yml.indexOf('\nfiles:'), yml.indexOf('\nasar:'));

test('P-1：排除未用云 SDK（aws/smithy/google/anthropic）', () => {
  for (const pattern of ['@aws-sdk', '@smithy', '@google', '@anthropic-ai']) {
    assert.ok(filesBlock.includes(`'!node_modules/${pattern}/**'`), `缺排除：${pattern}`);
  }
});

test('P-1 有牙：绝不排除 pi loader/provider 与 openai', () => {
  assert.equal(filesBlock.includes('@earendil-works'), false, '不得排除 @earendil-works/**（红线）');
  assert.equal(filesBlock.includes("!node_modules/openai"), false, '不得排除 openai（DeepSeek 链路依赖）');
  assert.match(yml, /node_modules\/@earendil-works\/\*\*/, 'asarUnpack 仍保留 pi 全量');
});
