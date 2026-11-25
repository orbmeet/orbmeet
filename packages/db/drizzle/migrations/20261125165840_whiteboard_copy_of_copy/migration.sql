-- A copy of a copy keeps its assets after the original is deleted (written
-- by hand: drizzle-kit does not model triggers).
--
-- A Whiteboard copy references the assets it shows by their owner's id
-- (`source_whiteboard_id`: provenance, and what each board's cleanup keeps
-- by). The trigger let a copy retain an asset only while its owner's upload
-- was committed, or while the owner itself referenced it, which it never
-- does. So once the original was deleted, duplicating a surviving copy, or
-- showing it in another Space, was refused for good.
--
-- An asset may be retained while something keeps its object: its owner's
-- committed upload, or another board's reference to it, which every purge
-- keeps the object for. Whether the board being copied may pass the asset on
-- (it holds that reference) is the copy's own check
-- (filterAuthorizedWhiteboardAssetKeys); this one keeps a reference from ever
-- pointing at an object nothing keeps.
DROP TRIGGER `whiteboard_asset_references_authorized_source_insert_check`;--> statement-breakpoint
DROP TRIGGER `whiteboard_asset_references_authorized_source_update_check`;--> statement-breakpoint
CREATE TRIGGER `whiteboard_asset_references_authorized_source_insert_check`
BEFORE INSERT ON `whiteboard_asset_references`
WHEN NOT EXISTS (
  SELECT 1 FROM `whiteboard_assets`
  WHERE `whiteboard_assets`.`r2_key` = NEW.`r2_key`
    AND `whiteboard_assets`.`whiteboard_id` = NEW.`source_whiteboard_id`
    AND `whiteboard_assets`.`status` = 'committed'
)
AND NOT EXISTS (
  SELECT 1 FROM `whiteboard_asset_references` AS `held`
  WHERE `held`.`r2_key` = NEW.`r2_key`
    AND `held`.`source_whiteboard_id` = NEW.`source_whiteboard_id`
    AND `held`.`whiteboard_id` <> NEW.`whiteboard_id`
)
BEGIN
  SELECT RAISE(ABORT, 'a Whiteboard copy can only retain an authorized source asset');
END;--> statement-breakpoint
CREATE TRIGGER `whiteboard_asset_references_authorized_source_update_check`
BEFORE UPDATE OF `source_whiteboard_id`, `r2_key` ON `whiteboard_asset_references`
WHEN NOT EXISTS (
  SELECT 1 FROM `whiteboard_assets`
  WHERE `whiteboard_assets`.`r2_key` = NEW.`r2_key`
    AND `whiteboard_assets`.`whiteboard_id` = NEW.`source_whiteboard_id`
    AND `whiteboard_assets`.`status` = 'committed'
)
AND NOT EXISTS (
  SELECT 1 FROM `whiteboard_asset_references` AS `held`
  WHERE `held`.`r2_key` = NEW.`r2_key`
    AND `held`.`source_whiteboard_id` = NEW.`source_whiteboard_id`
    AND `held`.`whiteboard_id` <> NEW.`whiteboard_id`
)
BEGIN
  SELECT RAISE(ABORT, 'a Whiteboard copy can only retain an authorized source asset');
END;--> statement-breakpoint
PRAGMA optimize;
