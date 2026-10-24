/**
 * The triggers the migrations create, by table: cross-table invariants a
 * CHECK cannot express. Drizzle does not model triggers, so they live only in
 * migration SQL — and a table rebuild drizzle-kit generates (create
 * `__new_<table>`, copy, drop, rename) silently drops the dropped table's
 * triggers. A migration that rebuilds one of these tables must recreate its
 * triggers; apps/web's D1 migration contract test fails until it does.
 */
export const DATABASE_TRIGGERS = {
  meeting_links: [
    "meeting_links_one_time_occurrence_count_update",
    "meeting_links_space_default_update_check",
  ],
  meeting_whiteboards: [
    "meeting_whiteboards_captured_revision_insert_check",
    "meeting_whiteboards_captured_revision_update_check",
    "meeting_whiteboards_start_revision_insert_check",
    "meeting_whiteboards_start_revision_update_check",
  ],
  meetings: [
    "meetings_one_time_link_single_occurrence_insert",
    "meetings_one_time_link_single_occurrence_update",
  ],
  space_default_meeting_links: [
    "space_default_meeting_links_insert_check",
    "space_default_meeting_links_update_check",
  ],
  spaces: ["spaces_kind_immutable_check"],
  transcripts: ["transcripts_meeting_projection_insert"],
  whiteboard_asset_references: [
    "whiteboard_asset_references_authorized_source_insert_check",
    "whiteboard_asset_references_authorized_source_update_check",
  ],
  whiteboard_revision_asset_references: [
    "whiteboard_revision_asset_references_authorized_asset_insert_check",
    "whiteboard_revision_asset_references_authorized_asset_update_check",
  ],
} as const satisfies Record<string, readonly string[]>;
