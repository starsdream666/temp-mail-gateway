-- 默认不启用；清理设置及上次执行时间随数据库持久化。
ALTER TABLE global_settings ADD COLUMN mailbox_cleanup_enabled INTEGER;
ALTER TABLE global_settings ADD COLUMN mailbox_cleanup_immediate INTEGER;
ALTER TABLE global_settings ADD COLUMN mailbox_cleanup_interval_ms INTEGER;
ALTER TABLE global_settings ADD COLUMN mailbox_cleanup_last_run_at INTEGER;

CREATE INDEX mailboxes_expires_idx ON mailboxes (expires_at);
