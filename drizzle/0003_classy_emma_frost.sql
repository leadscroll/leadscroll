CREATE TABLE `lead_tags` (
	`created_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`lead_id` text NOT NULL,
	`scope_id` text,
	`tag_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`scope_id`) REFERENCES `tag_scopes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lead_tags_lead_tag_unique` ON `lead_tags` (`lead_id`,`tag_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `lead_tags_lead_scope_unique` ON `lead_tags` (`lead_id`,`scope_id`) WHERE "lead_tags"."scope_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `lead_tags_lead_idx` ON `lead_tags` (`lead_id`);--> statement-breakpoint
CREATE INDEX `lead_tags_tag_idx` ON `lead_tags` (`tag_id`);--> statement-breakpoint
CREATE TABLE `tag_scopes` (
	`color` text NOT NULL,
	`created_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`prefix` text NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tag_scopes_workspace_prefix_unique` ON `tag_scopes` (`workspace_id`,`prefix`);--> statement-breakpoint
CREATE TABLE `tags` (
	`color` text,
	`created_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`scope_id` text,
	`updated_at` integer NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`scope_id`) REFERENCES `tag_scopes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_workspace_scope_name_unique` ON `tags` (`workspace_id`,`scope_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `tags_workspace_standalone_name_unique` ON `tags` (`workspace_id`,`name`) WHERE "tags"."scope_id" IS NULL;--> statement-breakpoint
CREATE INDEX `tags_workspace_scope_idx` ON `tags` (`workspace_id`,`scope_id`);
--> statement-breakpoint
-- Backfill legacy `leads.source` values into an inferred `source` scope and
-- per-value tags, then assign them. This is additive and lossless: the
-- `leads.source` column and its API compatibility are retained, and the raw
-- value is never truncated or dropped. Case/whitespace differences collapse to
-- one normalized tag while the original column keeps its exact text. IDs are
-- valid ULIDs: '0' followed by 25 uppercase hex characters.
INSERT INTO tag_scopes (id, workspace_id, prefix, color, created_at, updated_at)
SELECT
	'0' || substr(hex(randomblob(13)), 1, 25),
	src.workspace_id,
	'source',
	'teal',
	CAST(strftime('%s', 'now') AS integer) * 1000,
	CAST(strftime('%s', 'now') AS integer) * 1000
FROM (
	SELECT DISTINCT workspace_id
	FROM leads
	WHERE source IS NOT NULL AND trim(source) <> ''
) AS src
WHERE NOT EXISTS (
	SELECT 1 FROM tag_scopes s
	WHERE s.workspace_id = src.workspace_id AND s.prefix = 'source'
);
--> statement-breakpoint
INSERT INTO tags (id, workspace_id, name, scope_id, color, created_at, updated_at)
SELECT
	'0' || substr(hex(randomblob(13)), 1, 25),
	src.workspace_id,
	src.name,
	s.id,
	NULL,
	CAST(strftime('%s', 'now') AS integer) * 1000,
	CAST(strftime('%s', 'now') AS integer) * 1000
FROM (
	SELECT DISTINCT workspace_id, lower(trim(source)) AS name
	FROM leads
	WHERE source IS NOT NULL AND trim(source) <> ''
) AS src
JOIN tag_scopes s
	ON s.workspace_id = src.workspace_id AND s.prefix = 'source'
WHERE NOT EXISTS (
	SELECT 1 FROM tags t
	WHERE t.workspace_id = src.workspace_id
		AND t.scope_id = s.id
		AND t.name = src.name
);
--> statement-breakpoint
INSERT INTO lead_tags (id, workspace_id, lead_id, tag_id, scope_id, created_at)
SELECT
	'0' || substr(hex(randomblob(13)), 1, 25),
	l.workspace_id,
	l.id,
	t.id,
	t.scope_id,
	CAST(strftime('%s', 'now') AS integer) * 1000
FROM leads l
JOIN tag_scopes s
	ON s.workspace_id = l.workspace_id AND s.prefix = 'source'
JOIN tags t
	ON t.workspace_id = l.workspace_id
		AND t.scope_id = s.id
		AND t.name = lower(trim(l.source))
WHERE l.source IS NOT NULL AND trim(l.source) <> ''
	AND NOT EXISTS (
		SELECT 1 FROM lead_tags lt WHERE lt.lead_id = l.id AND lt.tag_id = t.id
	);
