-- 017_memory_fts.sql — v17（M4-B-6：memory_items FTS5）
--
-- 为什么需要：`D-17` 的 v1 检索口径是“FTS5 可用则用，不可用回退 LIKE”；016 只建了普通表，
-- `MemoryPort.search` 一直是 LIKE/词项。本迁移为 `memory_items` 建 FTS5 外部内容索引
-- （value + key + source_excerpt），用 trigram 支持中文子串；<3 字查询仍由应用层回退 LIKE。
-- 索引由触发器随 INSERT/UPDATE/DELETE 同步；历史行用 rebuild 建索引。
CREATE VIRTUAL TABLE IF NOT EXISTS memory_items_fts USING fts5(
  value,
  key,
  source_excerpt,
  content='memory_items',
  content_rowid='id',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS memory_items_fts_ai AFTER INSERT ON memory_items BEGIN
  INSERT INTO memory_items_fts(rowid, value, key, source_excerpt)
  VALUES (new.id, new.value, COALESCE(new.key, ''), COALESCE(new.source_excerpt, ''));
END;

CREATE TRIGGER IF NOT EXISTS memory_items_fts_ad AFTER DELETE ON memory_items BEGIN
  INSERT INTO memory_items_fts(memory_items_fts, rowid, value, key, source_excerpt)
  VALUES ('delete', old.id, old.value, COALESCE(old.key, ''), COALESCE(old.source_excerpt, ''));
END;

CREATE TRIGGER IF NOT EXISTS memory_items_fts_au AFTER UPDATE ON memory_items BEGIN
  INSERT INTO memory_items_fts(memory_items_fts, rowid, value, key, source_excerpt)
  VALUES ('delete', old.id, old.value, COALESCE(old.key, ''), COALESCE(old.source_excerpt, ''));
  INSERT INTO memory_items_fts(rowid, value, key, source_excerpt)
  VALUES (new.id, new.value, COALESCE(new.key, ''), COALESCE(new.source_excerpt, ''));
END;

INSERT INTO memory_items_fts(memory_items_fts) VALUES('rebuild');
