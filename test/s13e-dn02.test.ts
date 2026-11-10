/**
 *  P1/：项目页提供「接入已有文件夹」（复用 project:attach），成功后切范围。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync('src/renderer/components/ProjectsPage.tsx', 'utf8');
const store = readFileSync('src/renderer/store.ts', 'utf8');

test('D-N02① 项目页有接入入口并调用 store', () => {
  assert.match(page, /data-testid="projects-attach"/);
  assert.match(page, /attachExistingProject\(\)/);
  assert.match(page, /projects-attach-error/, '失败需就地显示');
});

test('D-N02② store 复用 project.attach 并切范围', () => {
  assert.match(store, /export async function attachExistingProject/);
  assert.match(store, /api\.project\.attach\(\)[\s\S]{0,900}channel\.scope_project_id/);
});
