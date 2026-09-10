-- 尽力删除（DELETE /v1/mailboxes/{id}?force=1）留下的残留线索。
-- 网关记录已删但上游可能仍保留那个邮箱；此前这个事实只出现在一次性的 HTTP 响应里，
-- 管理员事后无从得知「上游还欠一次清理」，孤儿会静默堆积。
-- 不设 upstream_id 外键：上游实例被删除后，孤儿线索仍需保留以便手工清理。
CREATE TABLE `orphan_mailboxes` (
	`id` text PRIMARY KEY NOT NULL,
	`upstream_id` text NOT NULL,
	`upstream_name` text NOT NULL,
	`address` text NOT NULL,
	`upstream_mailbox_id` text NOT NULL,
	`error_code` text,
	`error` text,
	`detected_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `orphan_detected_idx` ON `orphan_mailboxes` (`detected_at`);
