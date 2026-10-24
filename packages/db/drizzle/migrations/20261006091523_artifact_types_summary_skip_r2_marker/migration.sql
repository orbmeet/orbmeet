-- Why a settled Summary has no text, written by the summary job.
-- The R2 cleanup queue marks a key it is deleting; nothing may reference a
-- marked key (see r2KeyBeingDeletedSql in apps/web).
-- meeting_artifacts drops the never-registered whiteboard_snapshot and
-- whiteboard_state types. The rebuild runs with foreign keys enforced: no
-- table, trigger or view refers to meeting_artifacts, so its DROP cascades
-- nowhere.
ALTER TABLE `meetings` ADD `summary_skip_reason` text;--> statement-breakpoint
ALTER TABLE `r2_object_cleanup_tasks` ADD `deleting_at` integer;--> statement-breakpoint
CREATE TABLE `__new_meeting_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`meeting_id` text NOT NULL,
	`space_id` text NOT NULL,
	`revision_id` text,
	`type` text NOT NULL,
	`r2_key` text NOT NULL UNIQUE,
	`filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`uploaded_by_id` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_meeting_artifacts_meeting_id_meetings_id_fk` FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_meeting_artifacts_space_id_spaces_id_fk` FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_meeting_artifacts_revision_id_whiteboard_revisions_id_fk` FOREIGN KEY (`revision_id`) REFERENCES `whiteboard_revisions`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_meeting_artifacts_uploaded_by_id_users_id_fk` FOREIGN KEY (`uploaded_by_id`) REFERENCES `users`(`id`) ON DELETE SET NULL,
	CONSTRAINT `meeting_artifacts_meeting_space_fk` FOREIGN KEY (`meeting_id`,`space_id`) REFERENCES `meetings`(`id`,`space_id`),
	CONSTRAINT "meeting_artifacts_type_check" CHECK("type" in ('recording', 'whiteboard_pdf')),
	CONSTRAINT "meeting_artifacts_size_nonnegative_check" CHECK("size" >= 0),
	CONSTRAINT "meeting_artifacts_filename_length_check" CHECK(length("filename") <= 255 AND length(trim("filename")) BETWEEN 1 AND 255),
	CONSTRAINT "meeting_artifacts_mime_type_length_check" CHECK(length("mime_type") <= 100 AND length(trim("mime_type")) BETWEEN 1 AND 100),
	CONSTRAINT "meeting_artifacts_r2_key_length_check" CHECK(length("r2_key") <= 512),
	CONSTRAINT "meeting_artifacts_r2_key_check" CHECK((
        ("type" = 'recording'
          AND substr("r2_key", 1, 9) = 'meetings/'
          AND substr("r2_key", 10, length("meeting_id")) = "meeting_id"
          AND substr("r2_key", 10 + length("meeting_id"), 12) = '/recordings/')
        OR ("type" = 'whiteboard_pdf'
          AND (
            "r2_key" = 'meetings/' || "meeting_id" || '/exports/whiteboard.pdf'
            OR (
              substr("r2_key", 1, 9 + length("meeting_id") + 20)
                = 'meetings/' || "meeting_id" || '/exports/whiteboard/'
              AND length("r2_key") > 9 + length("meeting_id") + 24
              AND substr("r2_key", -4) = '.pdf'
            )
          ))
      ))
);
--> statement-breakpoint
INSERT INTO `__new_meeting_artifacts`(`id`, `meeting_id`, `space_id`, `revision_id`, `type`, `r2_key`, `filename`, `mime_type`, `size`, `uploaded_by_id`, `created_at`) SELECT `id`, `meeting_id`, `space_id`, `revision_id`, `type`, `r2_key`, `filename`, `mime_type`, `size`, `uploaded_by_id`, `created_at` FROM `meeting_artifacts`;--> statement-breakpoint
DROP TABLE `meeting_artifacts`;--> statement-breakpoint
ALTER TABLE `__new_meeting_artifacts` RENAME TO `meeting_artifacts`;--> statement-breakpoint
CREATE INDEX `meeting_artifacts_meeting_id_created_at_idx` ON `meeting_artifacts` (`meeting_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `meeting_artifacts_space_created_id_idx` ON `meeting_artifacts` (`space_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `meeting_artifacts_meeting_type_idx` ON `meeting_artifacts` (`meeting_id`,`type`);--> statement-breakpoint
CREATE INDEX `meeting_artifacts_revision_idx` ON `meeting_artifacts` (`revision_id`);--> statement-breakpoint
CREATE INDEX `meeting_artifacts_uploader_meeting_size_idx` ON `meeting_artifacts` (`uploaded_by_id`,`meeting_id`,`size`);--> statement-breakpoint
PRAGMA optimize;
