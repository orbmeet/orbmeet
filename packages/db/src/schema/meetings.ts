import { check, foreignKey, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import {
  BILLING_PRINCIPAL_TYPES as BILLING_PRINCIPAL_TYPE_VALUES,
  JOIN_POLICIES as JOIN_POLICY_VALUES,
  MEETING_ADMISSION_STATUSES as MEETING_ADMISSION_STATUS_VALUES,
  MEETING_ADMISSION_SUBJECT_TYPES as MEETING_ADMISSION_SUBJECT_TYPE_VALUES,
  MEETING_CONNECTION_STATUSES as MEETING_CONNECTION_STATUS_VALUES,
  MEETING_END_REASONS,
  MEETING_ROLES as MEETING_ROLE_VALUES,
  MEETING_STATUSES as MEETING_STATUS_VALUES,
  MEETING_SUMMARY_SKIP_REASONS,
  MEETING_SUMMARY_STATUSES,
  SPACE_KINDS as SPACE_KIND_VALUES,
  SUBSCRIPTION_TIERS as SUBSCRIPTION_TIER_VALUES,
} from "@orbmeet/domain-model";
import { oneOf, optionalTextLength, requiredTrimmedTextLength } from "./columns.ts";
import { users } from "./identity.ts";
import { spaces } from "./spaces.ts";
import { meetingLinks } from "./meeting-links.ts";

// ============================================================================
// MEETINGS
// ============================================================================

/**
 * A meeting is one bounded occurrence created from a meeting link. It
 * snapshots settings, billing principal, entitlement tier, and space kind at
 * start time so later link or Space changes do not rewrite meeting history.
 *
 * Cross-aggregate FKs are RESTRICT: history never disappears as a side
 * effect. Hard deletion is the orchestrated purge path only (meeting subtree
 * → meetings → schedules → links → space).
 */

export const meetings = sqliteTable(
  "meetings",
  {
    id: text("id").notNull().primaryKey(),
    // Immutable origin lineage, never product ownership.
    meetingLinkId: text("meeting_link_id")
      .notNull()
      .references(() => meetingLinks.id, { onDelete: "restrict" }),
    title: text("title"),
    // The user who started this occurrence. Space history survives account
    // deletion, so historical occurrences retain a null starter after that user
    // is removed rather than being deleted or reassigned.
    startedByUserId: text("started_by_user_id")
      .references(() => users.id, { onDelete: "set null" }),
    // The organizer of the scheduled meeting this occurrence fulfils, written
    // by the statement that claims the schedule. While none of the Space's
    // owner or admins is in the meeting, the organizer (else the starter)
    // stands in as host.
    organizerUserId: text("organizer_user_id")
      .references(() => users.id, { onDelete: "set null" }),
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "restrict" }),
    // Pinned copy of the immutable space kind (composite FK below).
    spaceKind: text("space_kind", { enum: SPACE_KIND_VALUES }).notNull(),
    status: text("status", { enum: MEETING_STATUS_VALUES })
      .default("open")
      .notNull(),
    // Policy snapshot taken from the link at start.
    allowGuests: integer("allow_guests", { mode: "boolean" }).default(false).notNull(),
    recordingEnabled: integer("recording_enabled", { mode: "boolean" }).default(false).notNull(),
    // Whether speech is being transcribed (sent to Deepgram) right now. Starts
    // from the starter's account setting; a host or co-host turns it on or off.
    transcriptionEnabled: integer("transcription_enabled", { mode: "boolean" }).default(true).notNull(),
    joinPolicy: text("join_policy", { enum: JOIN_POLICY_VALUES }).default("open").notNull(),
    startedAt: integer("started_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    endedAt: integer("ended_at", { mode: "timestamp" }),
    retainUntil: integer("retain_until", { mode: "timestamp" }),
    // Immutable billing snapshot: the subscription principal whose limits this
    // occurrence consumes (not necessarily the starter) and the entitlement
    // tier captured at start.
    billingPrincipalType: text("billing_principal_type", {
      enum: BILLING_PRINCIPAL_TYPE_VALUES,
    }).notNull(),
    billingPrincipalId: text("billing_principal_id").notNull(),
    billingPlan: text("billing_plan", { enum: SUBSCRIPTION_TIER_VALUES }).notNull(),
    // The media node hosting this Meeting's room, from the Worker's NODES. Null
    // until the first participant is admitted: an unplaced Meeting has no
    // room anywhere. Kept after the end as the record of where it ran.
    mediaNodeId: text("media_node_id"),
    // Projected by the meeting's coordinator: the running recording or stream,
    // and a revision that only grows. Written only by its MeetingRoom.
    activeEgressId: text("active_egress_id"),
    activeStreamEgressId: text("active_stream_egress_id"),
    egressStateRevision: integer("egress_state_revision").notNull().default(0),
    // When LiveKit first reported anyone in the room. Written once: only a
    // Meeting without it may be discarded as never started.
    firstJoinedAt: integer("first_joined_at", { mode: "timestamp" }),
    // When the coordinator finished everything the end left to do: egress
    // settled, recordings registered, room deleted. A purge waits for it.
    drainedAt: integer("drained_at", { mode: "timestamp" }),
    // Closing freezes presentation before any network capture starts.
    closingAt: integer("closing_at", { mode: "timestamp" }),
    closingWhiteboardId: text("closing_whiteboard_id"),
    closingCommandId: text("closing_command_id"),
    // Null when no Summary was owed at the end (summaries not configured).
    // Written by the end and by the meeting's summary jobs; see
    // MEETING_SUMMARY_STATUSES.
    summaryStatus: text("summary_status", { enum: MEETING_SUMMARY_STATUSES }),
    // Set with `settled` when the job wrote no Summary, and cleared when a new
    // one is owed; see MEETING_SUMMARY_SKIP_REASONS.
    summarySkipReason: text("summary_skip_reason", { enum: MEETING_SUMMARY_SKIP_REASONS }),
    // Increases each time a Summary is owed. Each value names exactly one
    // summary job, so owing a Summary always starts work that can run, and a
    // job whose number is no longer current knows it was superseded.
    summaryRequestSeq: integer("summary_request_seq").notNull().default(0),
    // Why it ended, written by the same statement that ends it; see
    // MEETING_END_REASONS. Null while open, and for meetings whose end was
    // never recorded.
    endReason: text("end_reason", { enum: MEETING_END_REASONS }),
    /**
     * Denormalized transcript-ingestion counters, bumped atomically by
     * Transcript ingest. Summary freshness checks and the client's Summary poll
     * read these instead of aggregating the transcripts table, which would
     * cost one row read per segment on every poll.
     */
    transcriptSegmentCount: integer("transcript_segment_count").notNull().default(0),
    transcriptLastIngestedAt: integer("transcript_last_ingested_at", { mode: "timestamp" }),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("meetings_link_status_idx").on(table.meetingLinkId, table.status),
    // Pin target: whiteboards, artifacts, and connections pin their space to
    // their meeting's space.
    uniqueIndex("meetings_id_space_id_unique_idx").on(table.id, table.spaceId),
    uniqueIndex("meetings_open_link_unique_idx")
      .on(table.meetingLinkId)
      .where(sql`${table.status} = 'open'`),
    // The shared-Space rule is also enforced at the occurrence boundary. This
    // remains useful defense in depth for imported/legacy rows and makes the
    // user-facing "one Meeting at a time" promise a schema fact.
    uniqueIndex("meetings_open_space_unique_idx")
      .on(table.spaceId)
      .where(sql`${table.status} = 'open' AND ${table.spaceKind} = 'shared'`),
    index("meetings_space_id_status_idx").on(table.spaceId, table.status),
    index("meetings_started_by_user_id_status_idx").on(table.startedByUserId, table.status),
    // Backs the organizer_user_id FK set-null on account deletion.
    index("meetings_organizer_user_id_idx").on(table.organizerUserId),
    index("meetings_billing_principal_status_idx").on(
      table.billingPrincipalType,
      table.billingPrincipalId,
      table.status,
    ),
    index("meetings_status_started_at_idx").on(table.status, table.startedAt),
    index("meetings_retain_until_idx").on(table.retainUntil),
    // The egress-ended webhook has no meeting id and resolves the meeting solely
    // by activeStreamEgressId. Partial so the index only carries rows for the
    // handful of meetings with a live web stream, not the whole retained history.
    index("meetings_active_stream_egress_idx")
      .on(table.activeStreamEgressId)
      .where(sql`${table.activeStreamEgressId} is not null`),
    // A meeting always lives in the space of the link that started it.
    foreignKey({
      columns: [table.meetingLinkId, table.spaceId],
      foreignColumns: [meetingLinks.id, meetingLinks.spaceId],
      name: "meetings_link_space_fk",
    }),
    foreignKey({
      columns: [table.spaceId, table.spaceKind],
      foreignColumns: [spaces.id, spaces.kind],
      name: "meetings_space_kind_fk",
    }),
    check("meetings_space_kind_check", oneOf(table.spaceKind, SPACE_KIND_VALUES)),
    check("meetings_title_length_check", optionalTextLength(table.title, 200)),
    check("meetings_status_check", oneOf(table.status, MEETING_STATUS_VALUES)),
    check("meetings_join_policy_check", oneOf(table.joinPolicy, JOIN_POLICY_VALUES)),
    // Guest entry is a personal-space capability; a shared-space occurrence
    // always snapshots it off.
    check(
      "meetings_guest_entry_check",
      sql`${table.spaceKind} = 'personal' OR ${table.allowGuests} = 0`,
    ),
    check(
      "meetings_billing_principal_type_check",
      oneOf(table.billingPrincipalType, BILLING_PRINCIPAL_TYPE_VALUES),
    ),
    check("meetings_billing_principal_id_length_check", requiredTrimmedTextLength(table.billingPrincipalId, 255)),
    check("meetings_billing_plan_check", oneOf(table.billingPlan, SUBSCRIPTION_TIER_VALUES)),
    check(
      "meetings_lifecycle_check",
      sql`(
        (${table.status} = 'open' AND ${table.endedAt} IS NULL)
        OR (${table.status} = 'ended' AND ${table.endedAt} IS NOT NULL)
      )`,
    ),
    check(
      "meetings_ended_after_started_check",
      sql`${table.endedAt} IS NULL OR ${table.endedAt} >= ${table.startedAt}`,
    ),
    check(
      "meetings_retain_after_end_check",
      sql`${table.retainUntil} IS NULL OR (${table.endedAt} IS NOT NULL AND ${table.retainUntil} >= ${table.endedAt})`,
    ),
    check(
      "meetings_updated_after_started_check",
      sql`${table.updatedAt} >= ${table.startedAt}`,
    ),
    check(
      "meetings_ended_egress_cleared_check",
      sql`${table.status} = 'open' OR ${table.activeEgressId} IS NULL`,
    ),
    check(
      "meetings_ended_stream_egress_cleared_check",
      sql`${table.status} = 'open' OR ${table.activeStreamEgressId} IS NULL`,
    ),
  ]
);

/**
 * Disposable UI projection for the Whiteboard surface shown during a live
 * Meeting. The durable focus remains on `meeting_whiteboards`; this row exists
 * only after the first surface command and is deleted when the Meeting ends.
 */

export const meetingWhiteboardSurfaces = sqliteTable(
  "meeting_whiteboard_surfaces",
  {
    meetingId: text("meeting_id")
      .notNull()
      .primaryKey()
      .references(() => meetings.id, { onDelete: "cascade" }),
    open: integer("open", { mode: "boolean" }).notNull().default(false),
    // Invocation-order fence for slow open preparation and focus switches.
    revision: integer("revision").notNull().default(0),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check(
      "meeting_whiteboard_surfaces_revision_nonnegative_check",
      sql`${table.revision} >= 0`,
    ),
  ],
);

/**
 * One person's standing in one Meeting: who they are (a user, or a guest known
 * only by the secret their cookie holds), whether they are waiting, approved,
 * denied, revoked or expired, and what was granted to them for this Meeting
 * (moderator, screen share, board editing). Written only by the Meeting's
 * coordinator, as its projection.
 */

export const meetingAdmissions = sqliteTable(
  "meeting_admissions",
  {
    id: text("id").notNull().primaryKey(),
    meetingId: text("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    subjectType: text("subject_type", { enum: MEETING_ADMISSION_SUBJECT_TYPE_VALUES }).notNull(),
    subjectUserId: text("subject_user_id").references(() => users.id, { onDelete: "cascade" }),
    guestSecretHash: text("guest_secret_hash"),
    displayName: text("display_name").notNull(),
    admissionStatus: text("admission_status", { enum: MEETING_ADMISSION_STATUS_VALUES })
      .default("pending")
      .notNull(),
    decisionReason: text("decision_reason"),
    decidedByUserId: text("decided_by_user_id").references(() => users.id, { onDelete: "set null" }),
    decidedAt: integer("decided_at", { mode: "timestamp" }),
    // A host-granted screen-share permission is otherwise only live SFU state
    // (set via `updateParticipant`) and would be lost when the app re-mints a
    // role-derived token on rejoin. Persist it here so token issuance can carry
    // it forward for a non-host participant.
    screenShareGranted: integer("screen_share_granted", { mode: "boolean" })
      .default(false)
      .notNull(),
    // A host or moderator let this attendee edit the Meeting's boards. Decided
    // by the coordinator like the grants above, and read by board token
    // issuance and the sync server's authority checks.
    whiteboardEditGranted: integer("whiteboard_edit_granted", { mode: "boolean" })
      .default(false)
      .notNull(),
    meetingModerator: integer("meeting_moderator", { mode: "boolean" })
      .default(false)
      .notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("meeting_admissions_id_meeting_id_unique_idx").on(table.id, table.meetingId),
    index("meeting_admissions_meeting_status_created_idx").on(table.meetingId, table.admissionStatus, table.createdAt),
    index("meeting_admissions_meeting_user_idx").on(table.meetingId, table.subjectUserId),
    index("meeting_admissions_meeting_created_idx").on(table.meetingId, table.createdAt),
    // Back the FK cascade/set-null on user deletion: without a left-most index on
    // these columns, deleting a user full-scans meeting_admissions once per axis.
    index("meeting_admissions_subject_user_id_idx").on(table.subjectUserId),
    index("meeting_admissions_decided_by_user_id_idx").on(table.decidedByUserId),
    check("meeting_admissions_subject_type_check", oneOf(table.subjectType, MEETING_ADMISSION_SUBJECT_TYPE_VALUES)),
    check("meeting_admissions_status_check", oneOf(table.admissionStatus, MEETING_ADMISSION_STATUS_VALUES)),
    check(
      "meeting_admissions_subject_shape_check",
      sql`(
        (${table.subjectType} = 'user' AND ${table.subjectUserId} IS NOT NULL AND ${table.guestSecretHash} IS NULL)
        OR (
          ${table.subjectType} = 'guest'
          AND ${table.subjectUserId} IS NULL
          AND (
            ${table.guestSecretHash} IS NOT NULL
            OR ${table.admissionStatus} IN ('denied', 'revoked', 'expired')
          )
        )
      )`,
    ),
    check(
      "meeting_admissions_decision_shape_check",
      sql`(
        (${table.admissionStatus} = 'approved' AND ${table.decidedAt} IS NOT NULL)
        OR (
          ${table.admissionStatus} IN ('denied', 'revoked', 'expired')
          AND ${table.screenShareGranted} = 0
          AND ${table.meetingModerator} = 0
          AND ${table.decidedAt} IS NOT NULL
        )
        OR (
          ${table.admissionStatus} = 'pending'
          AND ${table.screenShareGranted} = 0
          AND ${table.meetingModerator} = 0
          AND ${table.decisionReason} IS NULL
          AND ${table.decidedByUserId} IS NULL
          AND ${table.decidedAt} IS NULL
        )
      )`,
    ),
    check(
      "meeting_admissions_timestamps_check",
      sql`(
        ${table.updatedAt} >= ${table.createdAt}
        AND (${table.decidedAt} IS NULL OR ${table.decidedAt} >= ${table.createdAt})
      )`,
    ),
    check("meeting_admissions_display_name_length_check", requiredTrimmedTextLength(table.displayName, 100)),
    check("meeting_admissions_guest_secret_hash_length_check", optionalTextLength(table.guestSecretHash, 255)),
    check("meeting_admissions_decision_reason_length_check", optionalTextLength(table.decisionReason, 500)),
  ],
);

/**
 * One connection attempt: the credential issued for one join or rejoin, and
 * what became of it (pending → live → ended, never reissued). Written only by
 * the meeting's coordinator as its projection. Never used as post-meeting
 * authorization.
 */

export const meetingConnections = sqliteTable(
  "meeting_connections",
  {
    id: text("id").notNull().primaryKey(),
    meetingId: text("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    admissionId: text("admission_id").notNull().references(() => meetingAdmissions.id, { onDelete: "cascade" }),
    livekitIdentity: text("livekit_identity").notNull(),
    livekitParticipantSid: text("livekit_participant_sid"),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: MEETING_ROLE_VALUES }).notNull(),
    connectionStatus: text("connection_status", { enum: MEETING_CONNECTION_STATUS_VALUES })
      .default("pending")
      .notNull(),
    reason: text("reason"),
    tokenIssuedAt: integer("token_issued_at", { mode: "timestamp" }).notNull(),
    connectedAt: integer("connected_at", { mode: "timestamp" }),
    disconnectedAt: integer("disconnected_at", { mode: "timestamp" }),
    lastWebhookAt: integer("last_webhook_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("meeting_connections_id_meeting_id_unique_idx").on(table.id, table.meetingId),
    uniqueIndex("meeting_connections_meeting_identity_unique_idx").on(table.meetingId, table.livekitIdentity),
    // Backs the admission_id FK cascade. Deleting an admission (Space or
    // Meeting teardown) otherwise full-scans meeting_connections,
    // since the composite indexes are keyed on meeting_id first.
    index("meeting_connections_admission_id_idx").on(table.admissionId),
    index("meeting_connections_meeting_admission_status_updated_idx").on(table.meetingId, table.admissionId, table.connectionStatus, table.updatedAt),
    index("meeting_connections_meeting_status_connected_idx").on(table.meetingId, table.connectionStatus, table.connectedAt, table.tokenIssuedAt, table.id),
    index("meeting_connections_meeting_user_idx").on(table.meetingId, table.userId),
    index("meeting_connections_user_status_meeting_idx").on(table.userId, table.connectionStatus, table.meetingId),
    index("meeting_connections_user_meeting_idx").on(table.userId, table.meetingId),
    check("meeting_connections_role_check", oneOf(table.role, MEETING_ROLE_VALUES)),
    check("meeting_connections_status_check", oneOf(table.connectionStatus, MEETING_CONNECTION_STATUS_VALUES)),
    check(
      "meeting_connections_timestamp_shape_check",
      sql`(
        ${table.connectedAt} IS NULL OR ${table.connectedAt} >= ${table.tokenIssuedAt}
      ) AND (
        ${table.disconnectedAt} IS NULL OR ${table.disconnectedAt} >= ${table.tokenIssuedAt}
      ) AND (
        ${table.connectedAt} IS NULL OR ${table.disconnectedAt} IS NULL OR ${table.disconnectedAt} >= ${table.connectedAt}
      ) AND (
        ${table.lastWebhookAt} IS NULL OR ${table.lastWebhookAt} >= ${table.tokenIssuedAt}
      ) AND ${table.updatedAt} >= ${table.createdAt}`,
    ),
    check(
      "meeting_connections_status_timestamp_shape_check",
      sql`(
        (${table.connectionStatus} = 'pending' AND ${table.connectedAt} IS NULL AND ${table.disconnectedAt} IS NULL)
        OR (${table.connectionStatus} = 'live' AND ${table.connectedAt} IS NOT NULL AND ${table.disconnectedAt} IS NULL)
        OR (${table.connectionStatus} = 'ended' AND ${table.disconnectedAt} IS NOT NULL)
      )`,
    ),
    check("meeting_connections_livekit_identity_length_check", requiredTrimmedTextLength(table.livekitIdentity, 200)),
    check("meeting_connections_livekit_sid_length_check", optionalTextLength(table.livekitParticipantSid, 200)),
    check("meeting_connections_reason_length_check", optionalTextLength(table.reason, 200)),
    foreignKey({
      columns: [table.admissionId, table.meetingId],
      foreignColumns: [meetingAdmissions.id, meetingAdmissions.meetingId],
      name: "meeting_connections_admission_meeting_fk",
    }).onDelete("cascade"),
  ],
);

export type Meeting = typeof meetings.$inferSelect;
export type MeetingAdmission = typeof meetingAdmissions.$inferSelect;
export type MeetingConnection = typeof meetingConnections.$inferSelect;
