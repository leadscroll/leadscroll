-- One installation is one shared lead database and staff boundary. This
-- forward migration removes the redundant singleton workspace entity and its
-- workspace_id scoping while preserving every record, id and real invariant.
--
-- The preflight is deliberately the first statement. Any row that does not
-- belong to the seeded default workspace is unexpected in this data model (the
-- application never created such rows), so the migration refuses to merge,
-- discard or normalize it. Wrangler applies a migration file as one D1 batch,
-- which is atomic: a refusal rolls back the preflight table and leaves the
-- database untouched. Re-run after inspecting and reconciling the listed
-- table manually.
CREATE TABLE `__workspace_removal_preflight` (
	`workspaces` integer NOT NULL,
	`leads` integer NOT NULL,
	`activities` integer NOT NULL,
	`api_tokens` integer NOT NULL,
	`idempotency_keys` integer NOT NULL,
	`tag_scopes` integer NOT NULL,
	`tags` integer NOT NULL,
	`lead_tags` integer NOT NULL,
	`notification_preferences` integer NOT NULL,
	`installation_config` integer NOT NULL,
	`audit_log` integer NOT NULL,
	CONSTRAINT `workspace_removal_refused_non_default_workspaces` CHECK (`workspaces` = 0),
	CONSTRAINT `workspace_removal_refused_non_default_leads` CHECK (`leads` = 0),
	CONSTRAINT `workspace_removal_refused_non_default_activities` CHECK (`activities` = 0),
	CONSTRAINT `workspace_removal_refused_non_default_api_tokens` CHECK (`api_tokens` = 0),
	CONSTRAINT `workspace_removal_refused_non_default_idempotency_keys` CHECK (`idempotency_keys` = 0),
	CONSTRAINT `workspace_removal_refused_non_default_tag_scopes` CHECK (`tag_scopes` = 0),
	CONSTRAINT `workspace_removal_refused_non_default_tags` CHECK (`tags` = 0),
	CONSTRAINT `workspace_removal_refused_non_default_lead_tags` CHECK (`lead_tags` = 0),
	CONSTRAINT `workspace_removal_refused_non_default_notification_preferences` CHECK (`notification_preferences` = 0),
	CONSTRAINT `workspace_removal_refused_non_default_installation_config` CHECK (`installation_config` = 0),
	CONSTRAINT `workspace_removal_refused_non_default_audit_log` CHECK (`audit_log` = 0)
);
--> statement-breakpoint
INSERT INTO `__workspace_removal_preflight` (
	`workspaces`, `leads`, `activities`, `api_tokens`, `idempotency_keys`,
	`tag_scopes`, `tags`, `lead_tags`, `notification_preferences`,
	`installation_config`, `audit_log`
)
SELECT
	(SELECT count(*) FROM `workspaces` WHERE `id` <> '01ARZ3NDEKTSV4RRFFQ69G5FAV'),
	(SELECT count(*) FROM `leads` WHERE `workspace_id` <> '01ARZ3NDEKTSV4RRFFQ69G5FAV'),
	(SELECT count(*) FROM `activities` WHERE `workspace_id` <> '01ARZ3NDEKTSV4RRFFQ69G5FAV'),
	(SELECT count(*) FROM `api_tokens` WHERE `workspace_id` <> '01ARZ3NDEKTSV4RRFFQ69G5FAV'),
	(SELECT count(*) FROM `idempotency_keys` WHERE `workspace_id` <> '01ARZ3NDEKTSV4RRFFQ69G5FAV'),
	(SELECT count(*) FROM `tag_scopes` WHERE `workspace_id` <> '01ARZ3NDEKTSV4RRFFQ69G5FAV'),
	(SELECT count(*) FROM `tags` WHERE `workspace_id` <> '01ARZ3NDEKTSV4RRFFQ69G5FAV'),
	(SELECT count(*) FROM `lead_tags` WHERE `workspace_id` <> '01ARZ3NDEKTSV4RRFFQ69G5FAV'),
	(SELECT count(*) FROM `notification_preferences` WHERE `workspace_id` <> '01ARZ3NDEKTSV4RRFFQ69G5FAV'),
	(SELECT count(*) FROM `installation_config` WHERE `workspace_id` <> '01ARZ3NDEKTSV4RRFFQ69G5FAV'),
	(SELECT count(*) FROM `audit_log` WHERE `workspace_id` <> '01ARZ3NDEKTSV4RRFFQ69G5FAV');
--> statement-breakpoint
DROP TABLE `__workspace_removal_preflight`;
--> statement-breakpoint

-- Rebuild tables that carried workspace_id. New tables are created under
-- temporary names, copied row-for-row, then swapped in after the old tables
-- are dropped. New child tables point at the temporary parent names; renaming
-- each parent updates those references to the final name. Old children are
-- dropped before their parents, so the swap needs no deferred-foreign-key
-- state and cannot leave an implicit DELETE violation at commit.
CREATE TABLE `__new_leads` (
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
INSERT INTO `__new_leads` (
	`created_at`, `custom_fields`, `deleted_at`, `email`, `estimated_value`,
	`first_name`, `id`, `last_name`, `origin`, `raw_payload`, `skipped_fields`,
	`source`, `token_id`, `updated_at`
)
SELECT
	`created_at`, `custom_fields`, `deleted_at`, `email`, `estimated_value`,
	`first_name`, `id`, `last_name`, `origin`, `raw_payload`, `skipped_fields`,
	`source`, `token_id`, `updated_at`
FROM `leads`;
--> statement-breakpoint
CREATE TABLE `__new_tag_scopes` (
	`color` text NOT NULL,
	`created_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`prefix` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_tag_scopes` (`color`, `created_at`, `id`, `prefix`, `updated_at`)
SELECT `color`, `created_at`, `id`, `prefix`, `updated_at`
FROM `tag_scopes`;
--> statement-breakpoint
CREATE TABLE `__new_tags` (
	`color` text,
	`created_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`scope_id` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`scope_id`) REFERENCES `__new_tag_scopes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_tags` (`color`, `created_at`, `id`, `name`, `scope_id`, `updated_at`)
SELECT `color`, `created_at`, `id`, `name`, `scope_id`, `updated_at`
FROM `tags`;
--> statement-breakpoint
CREATE TABLE `__new_lead_tags` (
	`created_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`lead_id` text NOT NULL,
	`scope_id` text,
	`tag_id` text NOT NULL,
	FOREIGN KEY (`lead_id`) REFERENCES `__new_leads`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`scope_id`) REFERENCES `__new_tag_scopes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tag_id`) REFERENCES `__new_tags`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_lead_tags` (`created_at`, `id`, `lead_id`, `scope_id`, `tag_id`)
SELECT `created_at`, `id`, `lead_id`, `scope_id`, `tag_id`
FROM `lead_tags`;
--> statement-breakpoint
CREATE TABLE `__new_activities` (
	`actor_email` text,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`lead_id` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`lead_id`) REFERENCES `__new_leads`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_activities` (`actor_email`, `body`, `created_at`, `id`, `kind`, `lead_id`, `metadata`)
SELECT `actor_email`, `body`, `created_at`, `id`, `kind`, `lead_id`, `metadata`
FROM `activities`;
--> statement-breakpoint
CREATE TABLE `__new_api_tokens` (
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
INSERT INTO `__new_api_tokens` (
	`created_at`, `expires_at`, `id`, `last_used_at`, `name`, `prefix`,
	`revoked_at`, `scope`, `token`, `token_hash`, `type`
)
SELECT
	`created_at`, `expires_at`, `id`, `last_used_at`, `name`, `prefix`,
	`revoked_at`, `scope`, `token`, `token_hash`, `type`
FROM `api_tokens`;
--> statement-breakpoint
CREATE TABLE `__new_idempotency_keys` (
	`created_at` integer NOT NULL,
	`key` text NOT NULL,
	`request_hash` text,
	`response_json` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_idempotency_keys` (`created_at`, `key`, `request_hash`, `response_json`)
SELECT `created_at`, `key`, `request_hash`, `response_json`
FROM `idempotency_keys`;
--> statement-breakpoint
CREATE TABLE `__new_notification_preferences` (
	`new_lead_email` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text PRIMARY KEY NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_notification_preferences` (`new_lead_email`, `updated_at`, `user_id`)
SELECT `new_lead_email`, `updated_at`, `user_id`
FROM `notification_preferences`;
--> statement-breakpoint
CREATE TABLE `__new_installation_config` (
	`document_json` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`write_token` text,
	`write_version` integer DEFAULT 1 NOT NULL,
	CONSTRAINT "installation_config_singleton" CHECK("id" = 'installation')
);
--> statement-breakpoint
INSERT INTO `__new_installation_config` (`document_json`, `id`, `write_token`, `write_version`)
SELECT `document_json`, 'installation', `write_token`, `write_version`
FROM `installation_config`;
--> statement-breakpoint
CREATE TABLE `__new_audit_log` (
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
INSERT INTO `__new_audit_log` (
	`action`, `actor_user_id`, `changes_json`, `created_at`, `id`,
	`resource_id`, `resource_type`
)
SELECT
	`action`, `actor_user_id`, `changes_json`, `created_at`, `id`,
	`resource_id`, `resource_type`
FROM `audit_log`;
--> statement-breakpoint

DROP TABLE `lead_tags`;
--> statement-breakpoint
DROP TABLE `tags`;
--> statement-breakpoint
DROP TABLE `activities`;
--> statement-breakpoint
DROP TABLE `notification_preferences`;
--> statement-breakpoint
DROP TABLE `installation_config`;
--> statement-breakpoint
DROP TABLE `audit_log`;
--> statement-breakpoint
DROP TABLE `api_tokens`;
--> statement-breakpoint
DROP TABLE `idempotency_keys`;
--> statement-breakpoint
DROP TABLE `tag_scopes`;
--> statement-breakpoint
DROP TABLE `leads`;
--> statement-breakpoint
DROP TABLE `workspaces`;
--> statement-breakpoint

ALTER TABLE `__new_leads` RENAME TO `leads`;
--> statement-breakpoint
ALTER TABLE `__new_tag_scopes` RENAME TO `tag_scopes`;
--> statement-breakpoint
ALTER TABLE `__new_tags` RENAME TO `tags`;
--> statement-breakpoint
ALTER TABLE `__new_lead_tags` RENAME TO `lead_tags`;
--> statement-breakpoint
ALTER TABLE `__new_activities` RENAME TO `activities`;
--> statement-breakpoint
ALTER TABLE `__new_api_tokens` RENAME TO `api_tokens`;
--> statement-breakpoint
ALTER TABLE `__new_idempotency_keys` RENAME TO `idempotency_keys`;
--> statement-breakpoint
ALTER TABLE `__new_notification_preferences` RENAME TO `notification_preferences`;
--> statement-breakpoint
ALTER TABLE `__new_installation_config` RENAME TO `installation_config`;
--> statement-breakpoint
ALTER TABLE `__new_audit_log` RENAME TO `audit_log`;
--> statement-breakpoint

CREATE INDEX `leads_email_idx` ON `leads` (`email`);
--> statement-breakpoint
CREATE INDEX `leads_created_idx` ON `leads` (`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `tag_scopes_prefix_unique` ON `tag_scopes` (`prefix`);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_scope_name_unique` ON `tags` (`scope_id`,`name`);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_standalone_name_unique` ON `tags` (`name`) WHERE "tags"."scope_id" IS NULL;
--> statement-breakpoint
CREATE INDEX `tags_scope_idx` ON `tags` (`scope_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `lead_tags_lead_tag_unique` ON `lead_tags` (`lead_id`,`tag_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `lead_tags_lead_scope_unique` ON `lead_tags` (`lead_id`,`scope_id`) WHERE "lead_tags"."scope_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `lead_tags_lead_idx` ON `lead_tags` (`lead_id`);
--> statement-breakpoint
CREATE INDEX `lead_tags_tag_idx` ON `lead_tags` (`tag_id`);
--> statement-breakpoint
CREATE INDEX `activities_lead_created_idx` ON `activities` (`lead_id`,`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_token_unique` ON `api_tokens` (`token`);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_token_hash_unique` ON `api_tokens` (`token_hash`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idempotency_key_unique` ON `idempotency_keys` (`key`);
--> statement-breakpoint
CREATE INDEX `audit_log_created_idx` ON `audit_log` (`created_at`);
