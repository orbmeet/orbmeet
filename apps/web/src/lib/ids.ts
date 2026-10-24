export const ID_PREFIX = {
  USER: "user_", SESSION: "session_", PERSONAL_ACCESS_TOKEN: "pat_", DEVICE: "device_",
  PASSKEY: "passkey_", SPACE: "space_", MEETING_LINK: "link_", MEETING: "meeting_",
  MEETING_SCHEDULE: "schedule_", MEETING_SCHEDULE_ATTENDEE: "schedule_attendee_",
  MEETING_SCHEDULE_NOTIFICATION: "schedule_notification_", USER_CONTACT: "contact_",
  INVITE: "invite_", ASSET: "asset_", FILE: "file_", MEETING_ARTIFACT: "artifact_",
  MEMBER: "member_", MEETING_ADMISSION: "admission_", MEETING_CONNECTION: "connection_",
  MEETING_EVENT: "event_", WHITEBOARD: "whiteboard_", MEETING_WHITEBOARD: "meeting_whiteboard_",
  WHITEBOARD_REVISION: "whiteboard_revision_", WHITEBOARD_ASSET: "whiteboard_asset_",
  WHITEBOARD_EDIT_GRANT: "whiteboard_edit_grant_", WHITEBOARD_PURGE: "whiteboard_purge_", TASK: "task_", TASK_ASSIGNEE: "task_assignee_",
  TASK_RESPONSE: "task_response_", ACCOUNT: "account_", ACCOUNT_DELETION_CLEANUP: "account_cleanup_",
  TRANSCRIPT: "transcript_", MEETING_SUMMARY: "summary_", MEETING_FOLLOW_UP: "follow_up_", AUDIT: "audit_",
  ORGANIZATION: "organization_", ORGANIZATION_MEMBER: "organization_member_",
  SYNC_COMMAND: "sync_command_",
} as const;

const SORTABLE_ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

function encodeSortableId(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = value << 8n | BigInt(byte);
  let encoded = "";
  for (let index = 0; index < 26; index++) {
    encoded = SORTABLE_ID_ALPHABET[Number(value & 31n)] + encoded;
    value >>= 5n;
  }
  return encoded;
}

/**
 * A prefixed id that sorts by creation time. `createdAtMs` defaults to now; a
 * record imported from elsewhere passes its own creation time so the id sorts
 * where the record was born.
 */
export function generateId(prefix: keyof typeof ID_PREFIX, createdAtMs = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let timestamp = BigInt(createdAtMs);
  for (let index = 5; index >= 0; index--) {
    bytes[index] = Number(timestamp & 255n);
    timestamp >>= 8n;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return `${ID_PREFIX[prefix]}${encodeSortableId(bytes)}`;
}
