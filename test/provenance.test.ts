import test from 'node:test';
import assert from 'node:assert/strict';

import { getProvenance } from '../src/main/provenance.js';

// ── OPT-M8-2：证据 provenance（gitHead/dirty/version/generatedAt），best-effort 绝不抛 ──

test('provenance: 采集 gitHead/dirty/version/generatedAt（注入 git）', () => {
  const p = getProvenance({
    version: '0.0.1',
    nowIso: '2026-01-01T00:00:00.000Z',
    runGit: (args) => (args[0] === 'rev-parse' ? 'abc123\n' : ' M x\n'),
  });
  assert.deepEqual(p, {
    gitHead: 'abc123',
    dirty: true,
    version: '0.0.1',
    generatedAt: '2026-01-01T00:00:00.000Z',
  });
});

test('provenance: 干净工作区 → dirty=false', () => {
  const p = getProvenance({ version: 'x', runGit: (args) => (args[0] === 'rev-parse' ? 'h\n' : '') });
  assert.equal(p.gitHead, 'h');
  assert.equal(p.dirty, false);
});

test('provenance: git 不可用 → 字段 null、绝不抛', () => {
  const p = getProvenance({
    version: '0.0.1',
    runGit: () => {
      throw new Error('git not found');
    },
  });
  assert.equal(p.gitHead, null);
  assert.equal(p.dirty, null);
  assert.equal(p.version, '0.0.1');
  assert.ok(p.generatedAt.length > 0);
});
