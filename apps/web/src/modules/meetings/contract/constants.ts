import {
  JOIN_POLICIES,
  MEETING_LINK_REUSE_POLICIES,
  MEETING_ROLES,
  type MeetingConnectionStatus,
  type MeetingRole,
} from "@orbmeet/domain-model";

export {
  JOIN_POLICIES,
  MEETING_LINK_REUSE_POLICIES,
  MEETING_ROLES,
  type MeetingConnectionStatus,
  type MeetingRole,
};

export const MEETING_SUMMARY_MAX_LENGTH = 8_000;
export const MEETING_CODE_GROUPS = [3, 4, 3] as const;
export const MEETING_CODE_SOURCE = MEETING_CODE_GROUPS.map((size) => `[a-z]{${size}}`).join("-");
export const MEETING_CODE_REGEX = new RegExp(`^${MEETING_CODE_SOURCE}$`);
export const EXAMPLE_MEETING_CODE = MEETING_CODE_GROUPS.reduce<{ parts: string[]; at: number }>(
  (result, size) => {
    result.parts.push("abcdefghijklmnopqrstuvwxyz".slice(result.at, result.at + size));
    result.at += size;
    return result;
  },
  { parts: [], at: 0 },
).parts.join("-");

export const ONE_TIME_MEETING_LINK_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
export const SCHEDULED_MEETING_EARLY_JOIN_MS = 15 * 60 * 1000;
export const SCHEDULED_MEETING_LATE_JOIN_MS = 24 * 60 * 60 * 1000;
export const ADMISSION_PENDING_TTL_MS = 5 * 60 * 1000;
export const DISCONNECTED_TRANSCRIPT_GRACE_MS = 2 * 60 * 1000;

export function isModerationRole(role: string): boolean {
  return role === "host" || role === "moderator";
}

export function isGuestIdentity(identity: string): boolean {
  return identity.startsWith("guest_");
}

/** Data-packet topics: transient messages only. Moderator state is in contract/live-state. */
export const LIVEKIT_TOPICS = {
  CHAT: "chat",
} as const;

export const MESSAGE_LIMITS = {
  MAX_TEXT_LENGTH: 500,
  MAX_NAME_LENGTH: 100,
  MAX_EMOJI_LENGTH: 10,
} as const;
