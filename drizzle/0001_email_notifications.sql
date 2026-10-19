CREATE TABLE `audit_log` (
	`action` text NOT NULL,
	`actor_user_id` text,
	`changes_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`resource_id` text,
	`resource_type` text NOT NULL,
	FOREIGN KEY (`actor_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `audit_log_created_idx` ON `audit_log` (`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `installation_config` (
	`document_json` text NOT NULL,
	`id` integer PRIMARY KEY NOT NULL,
	`write_token` text,
	`updated_at` integer NOT NULL,
	CONSTRAINT "installation_config_singleton" CHECK("installation_config"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `notification_preferences` (
	`new_lead_email` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text PRIMARY KEY NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
