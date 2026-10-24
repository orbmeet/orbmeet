-- Where each board lives. Until now one node ran every board, and sg1 holds
-- every existing board's room database at generation 0: the generation a
-- room database without one has.
ALTER TABLE `whiteboards` ADD `sync_node_id` text;--> statement-breakpoint
ALTER TABLE `whiteboards` ADD `sync_generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `whiteboards` SET `sync_node_id` = 'sg1';--> statement-breakpoint
PRAGMA optimize;
