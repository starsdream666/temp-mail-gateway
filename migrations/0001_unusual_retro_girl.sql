ALTER TABLE `api_keys` ADD `domains_json` text;--> statement-breakpoint
ALTER TABLE `domains` ADD `enabled` integer DEFAULT true NOT NULL;