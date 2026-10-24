// Domain value sets shared by every runtime: the D1 schema's CHECK
// constraints, the web app's contracts, and the public API's schemas all
// read them from here instead of keeping private copies that drift apart.
// This package is pure data — no imports, no side effects, no runtime deps —
// so the Worker, the Node services, and the browser bundle can all take it.

export const SUBSCRIPTION_TIERS = ["free", "pro", "organization"] as const;
export const SUBSCRIPTION_STATUSES = [
  "active",
  "canceled",
  "past_due",
  "trialing",
  "paused",
] as const;
export const USER_ROLES = ["admin", "user"] as const;
/** Light, dark, or whatever the device is set to. */
export const APPEARANCES = ["system", "light", "dark"] as const;
export const VERIFICATION_TYPES = [
  "otp_signup",
  "otp_login",
  "otp_account_delete",
  "otp_step_up",
  "otp_delivery",
  "oauth_pkce",
  "passkey_register",
  "passkey_auth",
] as const;
export const PASSKEY_DEVICE_TYPES = ["singleDevice", "multiDevice"] as const;
// WebAuthn Level 3 permits credential IDs up to 1023 bytes. Base64url expands
// that payload to at most 1364 characters.
export const MAX_PASSKEY_CREDENTIAL_ID_LENGTH = 1364;

// Organization ownership lives on the organization row. Membership records
// store delegated authority only.
export const ORGANIZATION_MEMBER_ROLES = ["admin", "member"] as const;
// A Space's owner is stored once, on the Space (`spaces.owner_user_id`), and
// holds an `admin` membership like any other manager. A membership row stores
// only `admin` or `member`; "owner" is the role people see, derived from the
// Space. Organization-paid Spaces have no owner.
export const SPACE_ROLES = ["owner", "admin", "member"] as const;
export const SPACE_MEMBERSHIP_ROLES = ["admin", "member"] as const;
export const SPACE_AUDIT_ACTIONS = [
  "member_added",
  "member_removed",
  "member_left",
  "role_changed",
  "ownership_transferred",
  "invite_created",
  "invite_revoked",
  "invite_downgraded",
  "invite_rotated",
] as const;
// A personal space is the reified context for one user's own work; the UI
// never lists it as a space. The kind is immutable (trigger-enforced in the
// migration SQL) because meeting_links, meetings, and
// space_default_meeting_links pin it via composite FKs.
export const SPACE_KINDS = ["personal", "shared"] as const;

export const MEETING_LINK_REUSE_POLICIES = ["reusable", "one_time"] as const;
export const JOIN_POLICIES = ["open", "approval_required", "closed"] as const;
export const SCHEDULABLE_JOIN_POLICIES = ["open", "approval_required"] as const;
// Privilege axis only; auth (user vs guest) lives in
// meeting_admissions.subject_type.
export const MEETING_ROLES = ["host", "moderator", "attendee"] as const;
export const MEETING_STATUSES = ["open", "ended"] as const;
// Where an ended Meeting's Summary stands for its current transcript:
// `pending` while a summary job owes one, `settled` once that job finished
// (with a Summary, or with nothing to summarize), `failed` once it gave up.
export const MEETING_SUMMARY_STATUSES = ["pending", "settled", "failed"] as const;
// Why a `settled` Summary has no text: too little was said, more was said than
// one summary can cover, or summaries are not configured.
export const MEETING_SUMMARY_SKIP_REASONS = ["no_transcript", "transcript_too_large", "ai_not_configured"] as const;
// Why an ended Meeting ended: `host` ended it for everyone; `natural`, nobody
// was present, on the way in, or waiting for a while; `system`, the plan's
// duration limit, or a Space or account removal.
export const MEETING_END_REASONS = ["host", "natural", "system"] as const;
export const BILLING_PRINCIPAL_TYPES = ["user", "organization"] as const;
export const MEETING_SCHEDULE_NOTIFICATION_KINDS = [
  "invitation",
  "reminder",
  "rescheduled",
  "canceled",
] as const;
export const MEETING_SCHEDULE_NOTIFICATION_STATUSES = [
  "pending",
  "sent",
  "failed",
] as const;
export const EMAIL_SUPPRESSION_REASONS = [
  /** Hard bounce observed on our own send (`E_DELIVERY_FAILED`). */
  "bounced",
  /** Cloudflare already had the address suppressed (`E_RECIPIENT_SUPPRESSED`);
   * it does not say whether that was a bounce or a spam complaint. */
  "provider_suppressed",
  /** Reserved for the spam-complaint feedback loop, which arrives through
   * Email Sending event subscriptions rather than a send response. */
  "complained",
  /** One-click List-Unsubscribe. */
  "unsubscribed",
] as const;
export const PERSONAL_ACCESS_TOKEN_SCOPES = [
  "meetings:read",
  "meetings:write",
] as const;
export const USER_CONTACT_SOURCES = ["meeting", "invitation", "manual"] as const;
export const MEETING_ADMISSION_SUBJECT_TYPES = ["user", "guest"] as const;
export const MEETING_ADMISSION_STATUSES = [
  "pending",
  "approved",
  "denied",
  "revoked",
  "expired",
] as const;
export const MEETING_CONNECTION_STATUSES = ["pending", "live", "ended"] as const;

export const WHITEBOARD_STATUSES = ["active", "archived"] as const;
// `pre_restore` is the state a board held immediately before a Snapshot was
// restored over it. It is a distinct kind rather than a `manual` one because it
// is the *undo point*: History has to be able to say "Before restore · Jul 28"
// so the person who restored can find their way back, and a label is the whole
// value of a Snapshot nobody chose to take.
export const WHITEBOARD_REVISION_KINDS = [
  "checkpoint",
  "meeting_end",
  "manual",
  "pre_restore",
] as const;
export const MEETING_WHITEBOARD_CAPTURE_STATUSES = [
  "live",
  "capturing",
  "captured",
  "failed",
] as const;
export const WHITEBOARD_ASSET_STATUSES = [
  "pending",
  "committed",
  "deleting",
] as const;
export const WHITEBOARD_FILE_ROLES = ["source", "attachment"] as const;

export const FILE_STATUSES = ["pending", "committed", "deleting"] as const;
export const FILE_TYPES = ["pdf", "image"] as const;
export const FILE_MIME_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;
export const MEETING_ARTIFACT_TYPES = [
  "recording",
  "whiteboard_pdf",
] as const;

export type MeetingEndReason = (typeof MEETING_END_REASONS)[number];
export type SubscriptionTier = (typeof SUBSCRIPTION_TIERS)[number];
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];
export type SpaceRole = (typeof SPACE_ROLES)[number];
export type SpaceMembershipRole = (typeof SPACE_MEMBERSHIP_ROLES)[number];
export type SpaceAuditAction = (typeof SPACE_AUDIT_ACTIONS)[number];
export type MeetingRole = (typeof MEETING_ROLES)[number];
export type MeetingAdmissionSubjectType = (typeof MEETING_ADMISSION_SUBJECT_TYPES)[number];
export type MeetingAdmissionStatus = (typeof MEETING_ADMISSION_STATUSES)[number];
export type MeetingConnectionStatus = (typeof MEETING_CONNECTION_STATUSES)[number];
export type MeetingArtifactType = (typeof MEETING_ARTIFACT_TYPES)[number];
export type PersonalAccessTokenScope = (typeof PERSONAL_ACCESS_TOKEN_SCOPES)[number];
