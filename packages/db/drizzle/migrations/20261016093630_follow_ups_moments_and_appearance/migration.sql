CREATE TABLE `meeting_follow_ups` (
	`id` text PRIMARY KEY NOT NULL,
	`meeting_id` text NOT NULL,
	`position` integer NOT NULL,
	`text` text NOT NULL,
	`owner_name` text,
	`done_at` integer,
	`done_by_user_id` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_meeting_follow_ups_meeting_id_meetings_id_fk` FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_meeting_follow_ups_done_by_user_id_users_id_fk` FOREIGN KEY (`done_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL,
	CONSTRAINT "meeting_follow_ups_position_check" CHECK("position" >= 0),
	CONSTRAINT "meeting_follow_ups_text_length_check" CHECK(length("text") <= 300 AND length(trim("text")) BETWEEN 1 AND 300),
	CONSTRAINT "meeting_follow_ups_owner_name_length_check" CHECK("owner_name" IS NULL OR length("owner_name") <= 200),
	CONSTRAINT "meeting_follow_ups_done_shape_check" CHECK("done_by_user_id" IS NULL OR "done_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE `users` ADD `appearance` text DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE `meeting_summaries` ADD `moments` text;--> statement-breakpoint
CREATE INDEX `meeting_follow_ups_meeting_idx` ON `meeting_follow_ups` (`meeting_id`,`position`);--> statement-breakpoint
PRAGMA optimize;
