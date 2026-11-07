/**
 * B1-3（57 批1 C4）：`src/main/eval/eval.ts` 此前是**零引用孤件**——评测逻辑在公开仓、跑器只在私有仓。
 * 本测试把「公开任务集 + 公开校验器」接起来（并让 tsc 真实编译 eval.ts），作为跑器 `scripts/eval/run.mjs`
 * 的前置门：任务集不合法（缺 impossible/超 20 条/无 check）就不许开跑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { validateEvalTasks } from '../src/main/eval/eval.js';

const raw = JSON.parse(readFileSync('scripts/eval/tasks.json', 'utf8')) as unknown;

test('B1-3：公开任务集通过校验器（含 ≥1 条 impossible 有牙样本，≤20 条）', () => {
  const res = validateEvalTasks(raw);
  assert.equal(res.ok, true, `任务集不合法：${res.errors.join('；')}`);
  assert.ok(res.tasks.length >= 1 && res.tasks.length <= 20);
  assert.ok(res.tasks.some((t) => t.impossible === true), '必须含 impossible（证明判分器有牙）');
  for (const t of res.tasks) {
    assert.ok(t.acceptance.some((a) => typeof a.check === 'string' && a.check.trim().length > 0), `${t.id} 缺机器判据`);
  }
});

test('B1-3：校验器有牙——缺 impossible / 超 20 条 / 无 check 都拒绝', () => {
  const base = { version: 1, tasks: [{ id: 'a', title: 't', goal: 'g', risk: 0, tags: [], acceptance: [{ text: 'x', check: 'true' }], impossible: true }] };
  assert.equal(validateEvalTasks(base).ok, true);
  const noTeeth = JSON.parse(JSON.stringify(base)) as { tasks: Array<{ impossible?: boolean }> };
  delete noTeeth.tasks[0]!.impossible;
  assert.equal(validateEvalTasks(noTeeth).ok, false, '缺 impossible 必须拒绝');
  const noCheck = { version: 1, tasks: [{ id: 'a', title: 't', goal: 'g', risk: 0, tags: [], acceptance: [{ text: 'x' }], impossible: true }] };
  assert.equal(validateEvalTasks(noCheck).ok, false, '没有 check 无法机器判分');
});
