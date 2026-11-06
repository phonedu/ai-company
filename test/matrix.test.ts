/**
 * `test:matrix`（组合矩阵）的门测试 —— 纯逻辑单元（含「有牙」负例）。
 *
 * 口径见 `src/main/audit/matrix.ts` 头注；跑器＝`scripts/matrix/run.mjs`（headless 真引擎执行
 * `run`/`known` 格，不进本测试）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { MATRIX_CELLS, summarizeMatrix, type MatrixCell, type MatrixEnv } from '../src/main/audit/matrix.js';

test('summarizeMatrix：四态计数正确', () => {
  const mk = (status: MatrixCell['status']): MatrixCell => ({
    env: 'live' as MatrixEnv,
    scenario: status,
    status,
    ref: 'r',
    note: 'n',
  });
  assert.deepEqual(summarizeMatrix([mk('run'), mk('known'), mk('pointer'), mk('pending'), mk('pending')]), {
    run: 1,
    known: 1,
    pointer: 1,
    pending: 2,
    total: 5,
  });
});

test('矩阵目录：至少一格执行、每格有 ref/note、可执行格必有 assertion、env 合法（防退化成空矩阵）', () => {
  const envs = new Set(['empty-db', 'no-credential', 'legacy-db', 'live']);
  assert.ok(MATRIX_CELLS.length >= 8, `格子数不得少于 8（现 ${MATRIX_CELLS.length}）`);
  assert.ok(
    MATRIX_CELLS.some((c) => c.status === 'run'),
    '至少一个 run 格（防"全 pointer"退化成空矩阵）',
  );
  for (const cell of MATRIX_CELLS) {
    assert.ok(envs.has(cell.env), `env 非法：${cell.env}`);
    assert.ok(cell.ref.length > 0 && cell.note.length > 0, `${cell.env}×${cell.scenario} 缺 ref/note`);
    if (cell.status === 'run' || cell.status === 'known') {
      assert.ok((cell.assertion ?? '').length > 0, `${cell.env}×${cell.scenario} 执行格缺 assertion`);
    }
  }
});
