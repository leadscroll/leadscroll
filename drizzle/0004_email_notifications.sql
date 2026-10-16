CREATE TABLE `audit_log` (
	`action` text NOT NULL,
	`actor_user_id` text,
	`changes_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`resource_id` text,
	`resource_type` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`actor_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `audit_log_workspace_created_idx` ON `audit_log` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `installation_config` (
	`document_json` text NOT NULL,
	`workspace_id` text PRIMARY KEY NOT NULL,
	`write_token` text,
	`write_version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notification_preferences` (
	`new_lead_email` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `user_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
