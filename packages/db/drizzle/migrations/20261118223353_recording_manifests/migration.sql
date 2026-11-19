-- LiveKit Egress wrote a manifest, `<egress id>.json`, beside every recording,
-- and the daily sweep registered each one as a recording of its meeting.
-- Egress no longer writes them and only MP4 files are recordings now; this
-- removes the ones already registered. Their objects go to the R2 cleanup
-- queue, which deletes an object once no row refers to it.
INSERT INTO `r2_object_cleanup_tasks` (`r2_key`, `not_before`, `attempts`, `created_at`, `updated_at`)
SELECT `r2_key`, unixepoch(), 0, unixepoch(), unixepoch()
FROM `meeting_artifacts`
WHERE `type` = 'recording' AND `r2_key` NOT LIKE '%.mp4'
ON CONFLICT (`r2_key`) DO NOTHING;--> statement-breakpoint
DELETE FROM `meeting_artifacts` WHERE `type` = 'recording' AND `r2_key` NOT LIKE '%.mp4';--> statement-breakpoint
PRAGMA optimize;
