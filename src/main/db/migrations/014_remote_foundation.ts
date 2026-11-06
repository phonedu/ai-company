/**
 * 014_remote_foundation.ts — 迁移内联常量（**打包安全**；运行时零文件系统依赖）。
 * 与同目录 `014_remote_foundation.sql` 逐字一致（`test/migrations-packaging.test.ts` 校验漂移）。
 */
export const SQL_014_REMOTE_FOUNDATION = `-- 014_remote_foundation.sql — v14（M3-REM-1a：远程地基）
--
-- 两张表都只是本机 SQLite 的投影/日志，不改变任何业务事实：
--   ① read_cursors：老板频道/IM/mailbox 的未读高水位（principal + surface）；
--   ② remote_event_log：远程事件重放日志（seq 单调、永不复用；REM-1b 写入）。
-- 口径真源：docs/work/spec-remote-preconditions.md §3/§4。
--
-- 种子：历史消息在升级时视为已读基线（避免首次升级爆出大量旧消息未读）；
--       卡片**不种**——存量 pending 卡仍应提醒老板一次。
CREATE TABLE IF NOT EXISTS read_cursors (
  principal    TEXT NOT NULL,              -- boss | employee:<id>
  surface      TEXT NOT NULL,              -- channel:cards | channel:messages | im:<channel>:<ref> | mailbox:task:<id>
  last_item_id INTEGER NOT NULL,           -- 该 surface 源表的高水位（不是事件序号）
  last_read_at INTEGER,                    -- 服务端收到推进的时刻
  updated_at   INTEGER NOT NULL,
  source       TEXT NOT NULL,              -- desktop | remote | action | employee_session | im_receipt | migration
  PRIMARY KEY (principal, surface)
);

INSERT INTO read_cursors(principal, surface, last_item_id, last_read_at, updated_at, source)
SELECT 'boss', 'channel:messages', COALESCE(MAX(id), 0), NULL,
       CAST(strftime('%s', 'now') AS INTEGER) * 1000, 'migration'
FROM human_messages
WHERE NOT EXISTS (
  SELECT 1 FROM read_cursors WHERE principal = 'boss' AND surface = 'channel:messages'
);

CREATE TABLE IF NOT EXISTS remote_event_log (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT, -- SSE id / 重放游标；永不复用
  channel     TEXT NOT NULL,                     -- 远程白名单通道
  envelope    TEXT NOT NULL,                     -- 原 evt:batch 信封 JSON（含 batchSeq/items/emitAt）
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_remote_event_expiry ON remote_event_log(expires_at);
`;
