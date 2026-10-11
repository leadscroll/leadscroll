CREATE TABLE `email_credentials` (
	`ciphertext` text NOT NULL,
	`key_version` integer NOT NULL,
	`nonce` text NOT NULL,
	`provider` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_user_id` text,
	`workspace_id` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `provider`),
	FOREIGN KEY (`updated_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `email_settings` (
	`canonical_origin` text,
	`enabled` integer DEFAULT false NOT NULL,
	`from_email` text,
	`from_name` text,
	`provider` text DEFAULT 'disabled' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_user_id` text,
	`workspace_id` text PRIMARY KEY NOT NULL,
	`write_token` text,
	FOREIGN KEY (`updated_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `email_settings_audit` (
	`action` text NOT NULL,
	`actor_user_id` text,
	`created_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`reason_code` text,
	`revision` integer NOT NULL,
	`test_outcome` text,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `email_settings_audit_workspace_created_idx` ON `email_settings_audit` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `email_settings_permissions` (
	`granted_at` integer NOT NULL,
	`granted_by_user_id` text,
	`user_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `user_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
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
--> statement-breakpoint
CREATE TABLE `notification_test_attempts` (
	`completed_at` integer,
	`config_revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`provider` text,
	`provider_message_id` text,
	`reason_code` text,
	`status` text DEFAULT 'sending' NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `notification_test_attempts_workspace_created_idx` ON `notification_test_attempts` (`workspace_id`,`created_at`);
--> statement-breakpoint
INSERT OR IGNORE INTO `email_settings_permissions` (`workspace_id`, `user_id`, `granted_at`, `granted_by_user_id`)
SELECT '01ARZ3NDEKTSV4RRFFQ69G5FAV', rc.`user_id`, rc.`created_at`, NULL
FROM `registration_claims` rc
JOIN `user` u ON u.`id` = rc.`user_id`
WHERE rc.`grant_kind` = 'bootstrap' AND rc.`user_id` IS NOT NULL AND u.`disabled_at` IS NULL;
