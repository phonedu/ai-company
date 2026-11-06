/**
 * UG-04 · 建单附件 → 任务输入资产。
 *
 * 判据：
 *  - 复制到 `项目根/inputs/<短号>/<序号>-<文件名>`；
 *  - 登记 `artifacts.kind='input'`（sha256/来源 message:id）；
 *  - 原文件名中的路径片段被丢弃（不信任原始路径）；重复导入幂等；
 *  - 失败只报文件名，不回传绝对路径（D1）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { listArtifactsByTask, openMemoryDatabase, runMigrations } from '../src/main/db/index.js';
import { createSqliteChatRepo } from '../src/main/ipc/repo.js';
import { registerTaskInputArtifacts, type IpcDeps } from '../src/main/ipc/ipc.js';
import { stagedFileName } from '../src/main/ipc/staged-files.js';

function setup(): { root: string; staging: string; deps: IpcDeps; taskId: number; shortId: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'aico-input-'));
  const root = join(base, 'project');
  const staging = join(base, 'staging');
  mkdirSync(root, { recursive: true });
  mkdirSync(staging, { recursive: true });
  const db = openMemoryDatabase();
  runMigrations(db);
  const repo = createSqliteChatRepo(db);
  const project = repo.createProject({ name: '输入附件项目', rootDir: root, accessMode: 'inplace', now: 1 });
  const task = repo.createTask({ projectId: project.id, title: '带附件的任务', goal: 'g', riskLevel: 0 });
  return {
    root,
    staging,
    taskId: task.id,
    shortId: task.shortId ?? `T${task.id}`,
    deps: { repo, db, stagedFilesDir: () => staging },
    cleanup: () => {
      db.close();
      rmSync(base, { recursive: true, force: true });
    },
  };
}

test('UG-04 输入附件：复制 + artifacts.kind=input + sha/来源；重复幂等', () => {
  const f = setup();
  try {
    const token = randomUUID();
    const name = '字段差异.xlsx';
    const content = Buffer.from('fake-xlsx');
    writeFileSync(join(f.staging, stagedFileName(token, name)), content);
    const result = registerTaskInputArtifacts(
      f.deps,
      f.taskId,
      42,
      [{ name, size: content.length, type: 'application/vnd.ms-excel', fileToken: token }],
      100,
    );
    assert.deepEqual(result, { registered: 1, errors: [] });

    const rel = `inputs/${f.shortId}/1-${name}`;
    const copied = join(f.root, 'inputs', f.shortId, `1-${name}`);
    assert.deepEqual(readFileSync(copied), content);
    assert.equal(statSync(copied).size, content.length);
    const artifacts = listArtifactsByTask(f.deps.db!, f.taskId);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0]!.kind, 'input');
    assert.equal(artifacts[0]!.path, rel);
    assert.equal(artifacts[0]!.note, 'message:42');
    assert.equal(artifacts[0]!.source, 'message:42');
    assert.match(artifacts[0]!.sha256 ?? '', /^[0-9a-f]{64}$/);

    // 同一条消息重放：文件可重写，但 artifact 幂等（同 task/path 不叠行）。
    const again = registerTaskInputArtifacts(
      f.deps,
      f.taskId,
      42,
      [{ name, size: content.length, type: 'application/vnd.ms-excel', fileToken: token }],
      101,
    );
    assert.deepEqual(again, { registered: 1, errors: [] });
    assert.equal(listArtifactsByTask(f.deps.db!, f.taskId).length, 1, '重放不新增产物行');
  } finally {
    f.cleanup();
  }
});

test('UG-04 输入附件：原始文件名只取 basename（不把 ../ 写进路径）；坏 token 只报文件名', () => {
  const f = setup();
  try {
    const token = randomUUID();
    const name = '../../evil.txt';
    writeFileSync(join(f.staging, stagedFileName(token, name)), 'x');
    const result = registerTaskInputArtifacts(
      f.deps,
      f.taskId,
      43,
      [{ name, size: 1, type: 'text/plain', fileToken: token }],
      102,
    );
    assert.deepEqual(result, { registered: 1, errors: [] });
    const artifacts = listArtifactsByTask(f.deps.db!, f.taskId);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0]!.path, `inputs/${f.shortId}/1-evil.txt`);
    assert.equal(artifacts[0]!.path.includes('..'), false, '路径不得含 ..');

    const bad = registerTaskInputArtifacts(
      f.deps,
      f.taskId,
      44,
      [{ name: 'missing.bin', size: 1, type: 'application/octet-stream', fileToken: randomUUID() }],
      103,
    );
    assert.equal(bad.registered, 0);
    assert.equal(bad.errors.length, 1);
    assert.match(bad.errors[0]!, /missing\.bin/);
    assert.equal(bad.errors[0]!.includes(f.root), false, '错误不回传绝对路径');
  } finally {
    f.cleanup();
  }
});
