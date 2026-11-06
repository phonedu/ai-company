-- 021_context_metrics_model_hash.sql — CTX-1 P1（CTX1-9）：遥测补「本轮模型 + system prompt 指纹」。
-- 为什么：cache 命中率与 system 前缀稳定性要能按会话逐轮对照——只看层名布尔无法判断前缀是否抖动。
-- 口径：hash 为 sha256(systemPrompt) 十六进制；NULL＝旧行/未提供（不写假值）。
ALTER TABLE context_metrics ADD COLUMN model TEXT;
ALTER TABLE context_metrics ADD COLUMN system_prompt_hash TEXT;
