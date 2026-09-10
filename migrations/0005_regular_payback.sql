PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_domains` (
	`domain` text NOT NULL,
	`upstream_id` text NOT NULL,
	`is_private` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`synced_at` integer NOT NULL,
	PRIMARY KEY(`domain`, `upstream_id`),
	FOREIGN KEY (`upstream_id`) REFERENCES `upstreams`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_domains`("domain", "upstream_id", "is_private", "enabled", "synced_at") SELECT "domain", "upstream_id", "is_private", "enabled", "synced_at" FROM `domains`;--> statement-breakpoint
DROP TABLE `domains`;--> statement-breakpoint
ALTER TABLE `__new_domains` RENAME TO `domains`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `domains_upstream_idx` ON `domains` (`upstream_id`);