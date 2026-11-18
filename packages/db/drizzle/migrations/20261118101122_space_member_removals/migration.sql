CREATE TABLE `space_member_removals` (
	`space_id` text NOT NULL,
	`user_id` text NOT NULL,
	`removed_by_id` text,
	`removed_at` integer NOT NULL,
	CONSTRAINT `space_member_removals_pk` PRIMARY KEY(`space_id`, `user_id`),
	CONSTRAINT `fk_space_member_removals_space_id_spaces_id_fk` FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_space_member_removals_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_space_member_removals_removed_by_id_users_id_fk` FOREIGN KEY (`removed_by_id`) REFERENCES `users`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX `space_member_removals_user_id_idx` ON `space_member_removals` (`user_id`);--> statement-breakpoint
CREATE INDEX `space_member_removals_removed_by_id_idx` ON `space_member_removals` (`removed_by_id`);--> statement-breakpoint
PRAGMA optimize;
