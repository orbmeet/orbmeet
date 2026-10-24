-- Each node's services are probed apart: a LiveKit restart no longer
-- counts against the node's whiteboard. The old rows are a minute's probes,
-- which the next probe writes again.
CREATE TABLE `node_health` (
	`node_id` text NOT NULL,
	`service` text NOT NULL,
	`checked_at` integer NOT NULL,
	`failures` integer NOT NULL,
	`failing_since` integer,
	CONSTRAINT `node_health_pk` PRIMARY KEY(`node_id`, `service`),
	CONSTRAINT "node_health_node_id_length_check" CHECK(length("node_id") <= 64 AND length(trim("node_id")) BETWEEN 1 AND 64),
	CONSTRAINT "node_health_service_check" CHECK("service" in ('media', 'whiteboard')),
	CONSTRAINT "node_health_failures_check" CHECK("failures" >= 0)
);
--> statement-breakpoint
DROP TABLE `media_node_health`;--> statement-breakpoint
PRAGMA optimize;