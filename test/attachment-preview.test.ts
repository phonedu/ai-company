import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openMemoryDatabase, type SqliteDb } from '../src/main/db/open.js';
import { runMigrations } from '../src/main/db/migrate.js';
import { insertHumanMessage } from '../src/main/db/human_messages.js';
import { handleResolveAttachment } from '../src/main/ipc/attachment.js';
import { clearPreviewTokens, resolvePreviewToken } from '../src/main/ipc/attachment-preview.js';
import { isFileToken, stagedFilePath } from '../src/main/ipc/staged-files.js';

// ── 附件解析（chat:resolve-attachment）——真内存库 + 真 staging 文件，不依赖 Electron ──

function setup(): { db: SqliteDb; dir: string } {
  const db = openMemoryDatabase();
  runMigrations(db);
  const dir = mkdtempSync(join(tmpdir(), 'aico-att-'));
  return { db, dir };
}

function seedMessage(
  db: SqliteDb,
  attachment: { name: string; type?: string; token: string; size?: number },
): number {
  const row = insertHumanMessage(db, {
    direction: 'in',
    content: '带附件',
    attachments: [
      {
        name: attachment.name,
        size: attachment.size ?? 4,
        type: attachment.type ?? '',
        fileToken: attachment.token,
      },
    ],
    now: 1,
  });
  return row.id;
}

test('图片附件：返回 aico-file 短票；短票可解析到受控 staging 路径', () => {
  clearPreviewTokens();
  const { db, dir } = setup();
  try {
    const token = randomUUID();
    const file = join(dir, `${token}.png`);
    writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const messageId = seedMessage(db, { name: '截图.png', type: 'image/png', token });
    const result = handleResolveAttachment({ db, stagedFilesDir: () => dir }, { messageId, index: 0 });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.attachment.kind, 'image');
    assert.match(result.attachment.url ?? '', /^aico-file:\/\/preview\/[0-9a-f-]{36}$/);
    const previewToken = String(result.attachment.url).split('/').pop() as string;
    const entry = resolvePreviewToken(previewToken);
    assert.ok(entry, '短票应可解析');
    assert.equal(entry?.path, file);
    assert.equal(entry?.type, 'image/png');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('文本附件：返回前缀；超 200KB 如实截断', () => {
  clearPreviewTokens();
  const { db, dir } = setup();
  try {
    const token = randomUUID();
    const file = join(dir, `${token}.md`);
    writeFileSync(file, `# 标题\n${'x'.repeat(200 * 1024 + 10)}`, 'utf8');
    const messageId = seedMessage(db, { name: '说明.md', type: 'text/markdown', token });
    const result = handleResolveAttachment({ db, stagedFilesDir: () => dir }, { messageId, index: 0 });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.attachment.kind, 'text');
    assert.match(result.attachment.text ?? '', /^# 标题/);
    assert.equal(result.attachment.truncated, true);
    assert.equal(result.attachment.url, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('未知/越界：坏下标、缺令牌、文件不存在都显式拒（不返回路径）', () => {
  clearPreviewTokens();
  const { db, dir } = setup();
  try {
    const token = randomUUID();
    const messageId = seedMessage(db, { name: 'a.bin', type: 'application/octet-stream', token });
    const badIndex = handleResolveAttachment({ db, stagedFilesDir: () => dir }, { messageId, index: 2 });
    assert.equal(badIndex.ok, false);
    if (!badIndex.ok) assert.equal(badIndex.code, 'not_found');

    const missingToken = insertHumanMessage(db, {
      direction: 'in',
      content: '无令牌',
      attachments: [{ name: 'a.bin', size: 1, type: 'application/octet-stream' }],
      now: 2,
    });
    const noToken = handleResolveAttachment({ db, stagedFilesDir: () => dir }, { messageId: missingToken.id, index: 0 });
    assert.equal(noToken.ok, false);
    if (!noToken.ok) assert.equal(noToken.code, 'not_found');

    const missingFile = handleResolveAttachment({ db, stagedFilesDir: () => dir }, { messageId, index: 0 });
    assert.equal(missingFile.ok, false);
    if (!missingFile.ok) assert.equal(missingFile.code, 'not_found');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stagedFilePath：token 形状校验（拒绝路径注入）', () => {
  assert.equal(isFileToken('../../evil'), false);
  assert.equal(isFileToken(randomUUID()), true);
  assert.equal(stagedFilePath('D:/tmp', '../../evil', 'a.png'), null);
});
