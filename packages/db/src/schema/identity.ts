import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import {
  APPEARANCES as APPEARANCE_VALUES,
  MAX_PASSKEY_CREDENTIAL_ID_LENGTH,
  PASSKEY_DEVICE_TYPES as PASSKEY_DEVICE_TYPE_VALUES,
  PERSONAL_ACCESS_TOKEN_SCOPES as PERSONAL_ACCESS_TOKEN_SCOPE_VALUES,
  SUBSCRIPTION_STATUSES as SUBSCRIPTION_STATUS_VALUES,
  SUBSCRIPTION_TIERS as SUBSCRIPTION_TIER_VALUES,
  USER_ROLES as USER_ROLE_VALUES,
  VERIFICATION_TYPES as VERIFICATION_TYPE_VALUES,
} from "@orbmeet/domain-model";
import {
  billingEventTimestamp,
  JSON_TEXT_MAX_LENGTH,
  oneOf,
  optionalExactTextLength,
  optionalTextLength,
  requiredTrimmedTextLength,
} from "./columns.ts";

// ============================================================================
// AUTHENTICATION TABLES
// ============================================================================
// `updatedAt` auto-advances via Drizzle runtime hooks. Call sites can still
// set it explicitly when they need to reuse the exact timestamp value locally.

export const users = sqliteTable(
  "users",
  {
    id: text("id").notNull().primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    normalizedEmail: text("normalized_email").notNull().unique(),
    image: text("image"),
    // A user's durable scheduling default. Null means they have not chosen one
    // yet; clients may suggest their current device zone, but must not persist
    // or silently change it on the user's behalf.
    timeZone: text("time_zone"),
    plan: text("plan", { enum: SUBSCRIPTION_TIER_VALUES })
      .default("free")
      .notNull(),
    paddleCustomerId: text("paddle_customer_id"),
    paddleSubscriptionId: text("paddle_subscription_id"),
    subscriptionStatus: text("subscription_status", { enum: SUBSCRIPTION_STATUS_VALUES }),
    subscriptionUpdatedAt: billingEventTimestamp("subscription_updated_at"),
    // Set before account erasure begins. Ownership-creating statements check
    // this in the same write that assigns a restrict-FK, closing the race
    // between deletion preflight and destructive cleanup.
    deletionStartedAt: integer("deletion_started_at", { mode: "timestamp" }),
    role: text("role", { enum: USER_ROLE_VALUES })
      .default("user")
      .notNull(),
    // Whether meetings this user starts begin with transcription on: their
    // participants' speech sent to Deepgram for captions, the transcript and
    // the summary. A host or co-host can still change it in the meeting.
    transcribeMeetings: integer("transcribe_meetings", { mode: "boolean" }).default(true).notNull(),
    // Light, dark, or the device's own setting. Kept on the account so it
    // follows the person to another device; each browser also keeps a copy in
    // a cookie, which is what the first paint reads. No CHECK: SQLite can add
    // one only by rebuilding the table, and on D1 that rebuild's DROP TABLE
    // cascades into every table referencing a user. The one writer validates.
    appearance: text("appearance", { enum: APPEARANCE_VALUES }).default("system").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check("users_name_length_check", requiredTrimmedTextLength(table.name, 100)),
    check("users_email_length_check", sql`length(${table.email}) <= 320`),
    check("users_normalized_email_length_check", sql`length(${table.normalizedEmail}) <= 320`),
    check("users_image_length_check", optionalTextLength(table.image, 2048)),
    check("users_updated_after_created_check", sql`${table.updatedAt} >= ${table.createdAt}`),
    check("users_plan_check", oneOf(table.plan, SUBSCRIPTION_TIER_VALUES)),
    check(
      "users_subscription_status_check",
      sql`${table.subscriptionStatus} IS NULL OR ${oneOf(table.subscriptionStatus, SUBSCRIPTION_STATUS_VALUES)}`,
    ),
    check("users_role_check", oneOf(table.role, USER_ROLE_VALUES)),
    uniqueIndex("users_paddle_customer_id_idx").on(table.paddleCustomerId),
    uniqueIndex("users_paddle_subscription_id_idx").on(table.paddleSubscriptionId),
  ],
);

/**
 * A signed-in browser. Only a hash of the cookie token is stored; rotation keeps
 * the previous hash briefly so concurrent requests survive it. `expiresAt`
 * slides with activity, `absoluteExpiresAt` never does.
 */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").notNull().primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    previousTokenHash: text("previous_token_hash"),
    previousTokenExpiresAt: integer("previous_token_expires_at", { mode: "timestamp" }),
    rotationVersion: integer("rotation_version").notNull().default(0),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    // Hard cap — never renewed regardless of activity. Prevents indefinite
    // session persistence from a stolen cookie.
    absoluteExpiresAt: integer("absolute_expires_at", { mode: "timestamp" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("sessions_user_id_idx").on(table.userId),
    index("sessions_expires_at_idx").on(table.expiresAt),
    index("sessions_absolute_expires_at_idx").on(table.absoluteExpiresAt),
    index("sessions_previous_token_hash_idx").on(table.previousTokenHash),
    index("sessions_previous_token_expires_at_idx").on(table.previousTokenExpiresAt),
    check("sessions_token_hash_length_check", sql`length(${table.tokenHash}) = 64`),
    check("sessions_previous_token_hash_length_check", optionalExactTextLength(table.previousTokenHash, 64)),
    check(
      "sessions_previous_token_expiry_pair_check",
      sql`(${table.previousTokenHash} IS NULL) = (${table.previousTokenExpiresAt} IS NULL)`,
    ),
    check("sessions_expires_after_created_check", sql`${table.expiresAt} >= ${table.createdAt}`),
    check(
      "sessions_absolute_expires_after_expires_check",
      sql`${table.absoluteExpiresAt} >= ${table.expiresAt}`,
    ),
    check(
      "sessions_last_seen_after_created_check",
      sql`${table.lastSeenAt} IS NULL OR ${table.lastSeenAt} >= ${table.createdAt}`,
    ),
    check("sessions_ip_address_length_check", optionalTextLength(table.ipAddress, 64)),
    check("sessions_user_agent_length_check", optionalTextLength(table.userAgent, 500)),
  ]
);

/** User-created bearer credentials for the public automation API. */

export const personalAccessTokens = sqliteTable(
  "personal_access_tokens",
  {
    id: text("id").notNull().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    tokenPrefix: text("token_prefix").notNull(),
    scopes: text("scopes", { mode: "json" })
      .$type<Array<(typeof PERSONAL_ACCESS_TOKEN_SCOPE_VALUES)[number]>>()
      .notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }),
    lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
    revokedAt: integer("revoked_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("personal_access_tokens_user_id_idx").on(table.userId),
    index("personal_access_tokens_expires_at_idx").on(table.expiresAt),
    check("personal_access_tokens_name_length_check", requiredTrimmedTextLength(table.name, 100)),
    check("personal_access_tokens_hash_length_check", sql`length(${table.tokenHash}) = 64`),
    check("personal_access_tokens_prefix_length_check", requiredTrimmedTextLength(table.tokenPrefix, 24)),
    check(
      "personal_access_tokens_scopes_json_check",
      sql`json_valid(${table.scopes}) AND json_type(${table.scopes}) = 'array'`,
    ),
    check("personal_access_tokens_scopes_length_check", sql`length(${table.scopes}) <= 200`),
    check(
      "personal_access_tokens_expiry_check",
      sql`${table.expiresAt} IS NULL OR ${table.expiresAt} >= ${table.createdAt}`,
    ),
    check(
      "personal_access_tokens_last_used_check",
      sql`${table.lastUsedAt} IS NULL OR ${table.lastUsedAt} >= ${table.createdAt}`,
    ),
    check(
      "personal_access_tokens_revoked_check",
      sql`${table.revokedAt} IS NULL OR ${table.revokedAt} >= ${table.createdAt}`,
    ),
  ],
);

/** An external sign-in provider (e.g. Google) linked to a user: one per provider. */
export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").notNull().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    linkedAt: integer("linked_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("accounts_user_id_idx").on(table.userId),
    uniqueIndex("accounts_provider_account_idx").on(
      table.providerId,
      table.providerAccountId
    ),
    uniqueIndex("accounts_user_provider_idx").on(
      table.userId,
      table.providerId
    ),
  ]
);

/**
 * Short-lived proofs in flight: email codes, OAuth PKCE state and passkey
 * challenges, one per type and identifier, discarded once used or expired.
 */
export const verifications = sqliteTable(
  "verifications",
  {
    id: text("id").notNull().primaryKey(),
    type: text("type", {
      enum: VERIFICATION_TYPE_VALUES,
    }).notNull(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    data: text("data"),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("verifications_type_identifier_unique").on(table.type, table.identifier),
    index("verifications_identifier_idx").on(table.identifier),
    index("verifications_expires_at_idx").on(table.expiresAt),
    check("verifications_type_check", oneOf(table.type, VERIFICATION_TYPE_VALUES)),
    check(
      "verifications_data_json_check",
      sql`${table.data} IS NULL OR json_valid(${table.data})`,
    ),
    check("verifications_data_length_check", optionalTextLength(table.data, JSON_TEXT_MAX_LENGTH)),
    check(
      "verifications_expires_after_created_check",
      sql`${table.expiresAt} >= ${table.createdAt}`,
    ),
    check(
      "verifications_updated_after_created_check",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
  ]
);

/**
 * WebAuthn passkey credentials. One user can have multiple passkeys
 * (e.g. laptop Touch ID + phone Face ID).
 * credentialId is the raw credential ID bytes stored as base64url.
 * publicKey is the COSE-encoded public key stored as base64url.
 * counter is updated on every successful assertion to detect cloned authenticators.
 * transports is a JSON array of AuthenticatorTransport values used to hint the
 * browser which transport to prefer (e.g. ["internal"], ["hybrid","usb"]).
 */

export const passkeys = sqliteTable(
  "passkeys",
  {
    id: text("id").notNull().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    credentialId: text("credential_id").notNull().unique(),
    publicKey: text("public_key").notNull(),
    counter: integer("counter").notNull().default(0),
    // 'singleDevice' = bound to one device, 'multiDevice' = synced via platform (iCloud/Google)
    deviceType: text("device_type", { enum: PASSKEY_DEVICE_TYPE_VALUES }).notNull(),
    backedUp: integer("backed_up", { mode: "boolean" }).notNull().default(false),
    transports: text("transports", { mode: "json" }).$type<string[] | null>(), // JSON array: 'internal' | 'hybrid' | 'usb' | 'nfc' | 'ble'
    // User-visible label, either given by the user or auto-generated from UA
    name: text("name"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
  },
  (table) => [
    index("passkeys_user_id_idx").on(table.userId),
    check(
      "passkeys_credential_id_length_check",
      sql`length(${table.credentialId}) <= ${sql.raw(String(MAX_PASSKEY_CREDENTIAL_ID_LENGTH))}`,
    ),
    check("passkeys_public_key_length_check", sql`length(${table.publicKey}) <= 1024`),
    check("passkeys_device_type_check", oneOf(table.deviceType, PASSKEY_DEVICE_TYPE_VALUES)),
    check("passkeys_counter_nonnegative_check", sql`${table.counter} >= 0`),
    check(
      "passkeys_transports_json_check",
      sql`${table.transports} IS NULL OR (json_valid(${table.transports}) AND json_type(${table.transports}) = 'array')`,
    ),
    check("passkeys_transports_length_check", optionalTextLength(table.transports, 1024)),
    check(
      "passkeys_last_used_after_created_check",
      sql`${table.lastUsedAt} IS NULL OR ${table.lastUsedAt} >= ${table.createdAt}`,
    ),
    check("passkeys_name_length_check", optionalTextLength(table.name, 120)),
  ]
);

/**
 * Long-lived device recognition tokens stored in an HttpOnly cookie.
 * Survive session expiry and are used to show "Welcome back, X" on return visits
 * so users are never asked which account they used.
 * tokenHash is SHA-256 of the raw token held in the device cookie.
 */

export const devices = sqliteTable(
  "devices",
  {
    id: text("id").notNull().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // The sign-in that produced this device. A remembered device exists to skip
    // re-identifying the person on the machine that sign-in happened on, so its
    // authority ends with that session: revoking a session from the signed-in
    // devices list has to take the remembered identity with it, not leave a
    // cookie that still resolves the account's name, email and avatar.
    // Nullable for rows written before the column existed; those keep the old
    // lifetime until they expire.
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    // Human-readable label parsed from User-Agent at creation time
    label: text("label"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp" }),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("devices_user_id_idx").on(table.userId),
    index("devices_session_id_idx").on(table.sessionId),
    index("devices_expires_at_idx").on(table.expiresAt),
    check("devices_token_hash_length_check", sql`length(${table.tokenHash}) = 64`),
    check("devices_expires_after_created_check", sql`${table.expiresAt} >= ${table.createdAt}`),
    check(
      "devices_last_seen_after_created_check",
      sql`${table.lastSeenAt} IS NULL OR ${table.lastSeenAt} >= ${table.createdAt}`,
    ),
    check("devices_label_length_check", optionalTextLength(table.label, 200)),
  ]
);

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type PersonalAccessToken = typeof personalAccessTokens.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type Verification = typeof verifications.$inferSelect;
export type Passkey = typeof passkeys.$inferSelect;
export type Device = typeof devices.$inferSelect;
