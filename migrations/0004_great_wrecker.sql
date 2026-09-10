CREATE TABLE `health_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`upstream_id` text NOT NULL,
	`checked_at` integer NOT NULL,
	`status` text NOT NULL,
	`latency_ms` integer,
	`domains_total` integer,
	`domains_added_json` text,
	`domains_removed_json` text,
	`error` text,
	FOREIGN KEY (`upstream_id`) REFERENCES `upstreams`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `health_upstream_idx` ON `health_checks` (`upstream_id`,`checked_at`);