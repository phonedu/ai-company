/**
 * `test:mutations`（突变读数）的门测试 —— 纯逻辑单元（含「有牙」负例）。
 *
 * 口径见 `src/main/audit/mutation.ts` 头注；跑器＝`scripts/mutation/run.mjs`（dist 沙盒注入，
 * 不进本测试）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MUTATION_POINTS,
  applyMutation,
  mutationScore,
  type MutationOutcome,
  type MutationPoint,
} from '../src/main/audit/mutation.js';

const point: MutationPoint = { id: 'x', file: 'a.ts', find: 'K', replace: 'Z', tests: ['t'], ref: 'r', note: 'n' };

test('applyMutation 有牙：命中恰 1 次才注入；0 次 / 多次 ⇒ ok=false（防目录漂移被静默）', () => {
  assert.deepEqual(applyMutation('A K B', point), { ok: true, mutated: 'A Z B', count: 1 });
  assert.equal(applyMutation('A K B K C', point).ok, false, '两次命中不得注入');
  assert.equal(applyMutation('A K B K C', point).count, 2);
  assert.equal(applyMutation('A B C', point).ok, false, '零命中不得注入');
  assert.equal(applyMutation('A B C', point).count, 0);
});

test('mutationScore：killed/survived/setup-error 计数与杀伤率；无可判点 ⇒ score=null（不臆造 0）', () => {
  const mk = (verdict: MutationOutcome['verdict']): MutationOutcome => ({
    point: MUTATION_POINTS[0] as MutationPoint,
    verdict,
    detail: '',
  });
  const score = mutationScore([mk('killed'), mk('killed'), mk('survived'), mk('setup-error')]);
  assert.deepEqual(
    { killed: score.killed, survived: score.survived, setupErrors: score.setupErrors },
    { killed: 2, survived: 1, setupErrors: 1 },
  );
  assert.equal(score.score, 2 / 3);
  assert.equal(mutationScore([mk('setup-error')]).score, null, '无可判点不得报 0');
});

test('突变点目录：id 唯一、find/replace 非空且不同、聚焦测试非空（防目录退化成空转）', () => {
  assert.ok(MUTATION_POINTS.length >= 4, '至少 4 个高价值点');
  const ids = MUTATION_POINTS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'id 不得重复');
  for (const p of MUTATION_POINTS) {
    assert.ok(p.find.length > 0 && p.replace.length > 0 && p.find !== p.replace, p.id);
    assert.ok(p.tests.length > 0, `${p.id} 缺聚焦测试`);
    assert.ok(p.file.endsWith('.ts'), `${p.id} 应指向源码路径`);
    assert.ok(p.ref.length > 0 && p.note.length > 0, p.id);
  }
});
