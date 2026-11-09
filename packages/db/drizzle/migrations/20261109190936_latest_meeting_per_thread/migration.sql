DROP INDEX IF EXISTS `meetings_link_status_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `meetings_space_id_status_idx`;--> statement-breakpoint
CREATE INDEX `meetings_link_status_started_idx` ON `meetings` (`meeting_link_id`,`status`,`started_at`,`id`);--> statement-breakpoint
CREATE INDEX `meetings_space_status_started_idx` ON `meetings` (`space_id`,`status`,`started_at`,`id`);
PRAGMA optimize;
