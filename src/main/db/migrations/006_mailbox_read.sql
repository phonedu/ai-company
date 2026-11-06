-- 006_mailbox_read.sql — v6（R2-2/G7：员工间答复「已读」标记）
--
-- 为 mailbox（`notifications` 表 channel='employee:<id>'）加**已读时刻**：
--   · add-only、nullable ⇒ 老库升级零破坏；既有行 read_at=NULL（未读语义与加列前一致：答复本来就没被消费过）。
--   · 只有 `employee:*` 投递会写它；desktop/im 投递恒 NULL（那些走「待我处理」游标，不用本列）。
-- 真源：`schema.sql`（notifications 表注释）→ 本文件 → `gen-migrations` 生成 006_*.ts。
--
-- 口径（不改行为）：read_at 的写者 = `engine/mailbox.ts#markAnswersRead`，由员工执行器**post-run** 调用
-- （pre-run 把未读答复读进简报；会话正常收尾后标读——崩溃则下轮重读，宁可重复上屏，不静默丢失）。
ALTER TABLE notifications ADD COLUMN read_at INTEGER;
