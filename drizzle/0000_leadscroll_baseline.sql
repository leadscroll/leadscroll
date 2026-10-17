-- Squashed baseline epoch: final installation-wide schema (no workspaces).
-- Generated from src/db/schema.ts. The registration grant trigger and the
-- bootstrap seed below are hand-written SQL that Drizzle does not model.
CREATE TABLE `activities` (
	`actor_email` text,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`lead_id` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `activities_lead_created_idx` ON `activities` (`lead_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `api_tokens` (
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`id` text PRIMARY KEY NOT NULL,
	`last_used_at` integer,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`revoked_at` integer,
	`scope` text DEFAULT 'intake:write' NOT NULL,
	`token` text,
	`token_hash` text,
	`type` text DEFAULT 'api' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_token_unique` ON `api_tokens` (`token`);--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_token_hash_unique` ON `api_tokens` (`token_hash`);--> statement-breakpoint
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
CREATE INDEX `audit_log_created_idx` ON `audit_log` (`created_at`);--> statement-breakpoint
CREATE TABLE `bootstrap_state` (
	`consumed_at` integer,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	CONSTRAINT "bootstrap_state_default_only" CHECK(id = 'default')
);
--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`created_at` integer NOT NULL,
	`key` text NOT NULL,
	`request_hash` text,
	`response_json` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idempotency_key_unique` ON `idempotency_keys` (`key`);--> statement-breakpoint
CREATE TABLE `installation_config` (
	`document_json` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`write_token` text,
	`write_version` integer DEFAULT 1 NOT NULL,
	CONSTRAINT "installation_config_singleton" CHECK("id" = 'installation')
);
--> statement-breakpoint
CREATE TABLE `lead_tags` (
	`created_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`lead_id` text NOT NULL,
	`scope_id` text,
	`tag_id` text NOT NULL,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`scope_id`) REFERENCES `tag_scopes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lead_tags_lead_tag_unique` ON `lead_tags` (`lead_id`,`tag_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `lead_tags_lead_scope_unique` ON `lead_tags` (`lead_id`,`scope_id`) WHERE "lead_tags"."scope_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `lead_tags_lead_idx` ON `lead_tags` (`lead_id`);--> statement-breakpoint
CREATE INDEX `lead_tags_tag_idx` ON `lead_tags` (`tag_id`);--> statement-breakpoint
CREATE TABLE `leads` (
	`created_at` integer NOT NULL,
	`custom_fields` text DEFAULT '{}' NOT NULL,
	`deleted_at` integer,
	`email` text,
	`estimated_value` integer,
	`first_name` text,
	`id` text PRIMARY KEY NOT NULL,
	`last_name` text,
	`origin` text,
	`raw_payload` text,
	`skipped_fields` text,
	`source` text NOT NULL,
	`token_id` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `leads_email_idx` ON `leads` (`email`);--> statement-breakpoint
CREATE INDEX `leads_created_idx` ON `leads` (`created_at`);--> statement-breakpoint
CREATE TABLE `notification_preferences` (
	`new_lead_email` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text PRIMARY KEY NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `rate_limit` (
	`count` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`last_request` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rate_limit_key_unique` ON `rate_limit` (`key`);--> statement-breakpoint
CREATE TABLE `registration_claims` (
	`claim_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`grant_kind` text NOT NULL,
	`grant_ref` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `registration_claims_claim_key_unique` ON `registration_claims` (`claim_key`);--> statement-breakpoint
CREATE TABLE `staff_invites` (
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`revoked_at` integer,
	`token_hash` text NOT NULL,
	`used_at` integer,
	`used_by_user_id` text,
	FOREIGN KEY (`used_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `staff_invites_token_hash_unique` ON `staff_invites` (`token_hash`);--> statement-breakpoint
CREATE TABLE `tag_scopes` (
	`color` text NOT NULL,
	`created_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`prefix` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tag_scopes_prefix_unique` ON `tag_scopes` (`prefix`);--> statement-breakpoint
CREATE TABLE `tags` (
	`color` text,
	`created_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`scope_id` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`scope_id`) REFERENCES `tag_scopes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_scope_name_unique` ON `tags` (`scope_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `tags_standalone_name_unique` ON `tags` (`name`) WHERE "tags"."scope_id" IS NULL;--> statement-breakpoint
CREATE INDEX `tags_scope_idx` ON `tags` (`scope_id`);--> statement-breakpoint
CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_userId_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_userId_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`disabled_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);
--> statement-breakpoint
CREATE TRIGGER `registration_claims_grant_guard` BEFORE INSERT ON `registration_claims`
WHEN (NEW.grant_kind = 'bootstrap'
      AND NOT EXISTS (SELECT 1 FROM bootstrap_state WHERE id = 'default' AND consumed_at IS NULL AND expires_at > NEW.created_at))
  OR (NEW.grant_kind = 'invite'
      AND NOT EXISTS (SELECT 1 FROM staff_invites WHERE token_hash = NEW.grant_ref AND used_at IS NULL AND revoked_at IS NULL AND expires_at > NEW.created_at))
BEGIN
  SELECT RAISE(ABORT, 'registration grant unavailable');
END;
--> statement-breakpoint
INSERT OR IGNORE INTO `bootstrap_state` ("id", "created_at", "expires_at", "consumed_at") VALUES ('default', CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now', '+7 days') AS INTEGER) * 1000, NULL);
