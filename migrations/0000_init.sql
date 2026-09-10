CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`prefix` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_used_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE TABLE `domains` (
	`domain` text PRIMARY KEY NOT NULL,
	`upstream_id` text NOT NULL,
	`is_private` integer DEFAULT false NOT NULL,
	`synced_at` integer NOT NULL,
	FOREIGN KEY (`upstream_id`) REFERENCES `upstreams`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `domains_upstream_idx` ON `domains` (`upstream_id`);--> statement-breakpoint
CREATE TABLE `mailboxes` (
	`id` text PRIMARY KEY NOT NULL,
	`upstream_id` text NOT NULL,
	`address` text NOT NULL,
	`local_part` text NOT NULL,
	`domain` text NOT NULL,
	`upstream_mailbox_id` text NOT NULL,
	`credentials_enc` text,
	`password_enc` text,
	`api_key_id` text,
	`webhook_url` text,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`upstream_id`) REFERENCES `upstreams`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mailboxes_address_unique` ON `mailboxes` (`address`);--> statement-breakpoint
CREATE INDEX `mailboxes_upstream_idx` ON `mailboxes` (`upstream_id`);--> statement-breakpoint
CREATE INDEX `mailboxes_created_idx` ON `mailboxes` (`created_at`);--> statement-breakpoint
CREATE TABLE `upstreams` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`base_url` text NOT NULL,
	`api_key_enc` text,
	`settings_json` text DEFAULT '{}' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
