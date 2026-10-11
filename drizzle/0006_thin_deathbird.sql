DROP TABLE `notification_dispatch_state`;--> statement-breakpoint
DROP TABLE `notification_outbox`;--> statement-breakpoint
ALTER TABLE `email_settings` DROP COLUMN `paused_at`;--> statement-breakpoint
ALTER TABLE `email_settings` DROP COLUMN `paused_reason_code`;--> statement-breakpoint
ALTER TABLE `email_settings` DROP COLUMN `paused_revision`;--> statement-breakpoint
ALTER TABLE `notification_test_attempts` DROP COLUMN `delivery_key`;--> statement-breakpoint
ALTER TABLE `notification_test_attempts` DROP COLUMN `frozen_envelope_json`;