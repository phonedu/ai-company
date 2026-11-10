-- 013_im_outbox.sql — v13（M3-REM-2 / 微信 1:1：主动卡片投递队列）
--
-- 卡片先落 reports（事实源）；本表只负责“送到哪个会话、送到什么状态”。
-- 平台窗口（微信 context_token / 24h）导致发不出时置 blocked，等下一次入站补发；
-- 绝不假装已送达。本轮只实现 im:wechat 1:1；群聊/其他通道不建对象。
-- 真源：`schema.sql`（im_outbox 表）→ 本文件 → `gen-migrations` 生成 013_*.ts。
CREATE TABLE IF NOT EXISTS im_outbox (
  id              INTEGER PRIMARY KEY,
  channel         TEXT NOT NULL,            -- im:wechat（本轮只实现微信；其他通道登记不实现）
  conversation_ref TEXT NOT NULL,           -- 老板私聊会话 id
  report_id       INTEGER NOT NULL REFERENCES reports(id),
  task_id         INTEGER REFERENCES tasks(id),
  state           TEXT NOT NULL DEFAULT 'pending', -- pending | sending | sent | blocked | failed | cancelled | expired
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  next_attempt_at INTEGER,
  platform_msg_id TEXT,
  created_at      INTEGER NOT NULL,
  sent_at         INTEGER,
  UNIQUE(channel, conversation_ref, report_id)
);
CREATE INDEX IF NOT EXISTS idx_im_outbox_due ON im_outbox(state, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_im_outbox_report ON im_outbox(report_id);
