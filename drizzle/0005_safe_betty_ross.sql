ALTER TABLE `notification_outbox` ADD `uncertain_at` integer;--> statement-breakpoint
CREATE INDEX `notification_outbox_cleanup_idx` ON `notification_outbox` (`status`,`updated_at`);