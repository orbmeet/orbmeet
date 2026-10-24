import type { SubscriptionTier } from "./types";

export type { SubscriptionTier } from "./types";

export interface PlanLimits {
  maxParticipants: number | null; // null = unlimited
  maxConcurrentMeetings: number | null; // null = unlimited
  maxMeetingDurationMinutes: number | null; // null = unlimited
  maxSpaces: number | null; // null = unlimited
  maxMembersPerSpace: number | null; // null = unlimited; counts the owner
  /** Active durable document count. Archived Whiteboards do not consume a
   *  slot. Always finite, including Organization plans, so one compromised
   *  member cannot create unbounded D1 rows and sync rooms. */
  maxWhiteboardsPerSpace: number;
  /** Undo snapshots created by explicit restores. System-managed
   *  Meeting-boundary revisions are not charged to this cap. */
  maxWhiteboardRestorePointsPerBoard: number;
  maxStorageBytes: number | null; // null = unlimited
  recordingEnabled: boolean;
  streamingEnabled: boolean;
  pdfExportEnabled: boolean;
  aiFeaturesEnabled: boolean;
  customPersonalMeetingCode: boolean;   // choose the code for a personal reusable link
}

export const PLAN_LIMITS: Record<SubscriptionTier, PlanLimits> = {
  free: {
    maxParticipants: 100,
    maxConcurrentMeetings: 1,
    maxMeetingDurationMinutes: 90,
    maxSpaces: 1,
    maxMembersPerSpace: 25,
    maxWhiteboardsPerSpace: 100,
    maxWhiteboardRestorePointsPerBoard: 25,
    maxStorageBytes: 1 * 1024 * 1024 * 1024, // 1 GB
    recordingEnabled: false,
    streamingEnabled: true,
    pdfExportEnabled: true,
    aiFeaturesEnabled: true,
    customPersonalMeetingCode: false,
  },
  pro: {
    maxParticipants: 500,
    maxConcurrentMeetings: 5,
    maxMeetingDurationMinutes: null,
    maxSpaces: null,
    maxMembersPerSpace: 200,
    maxWhiteboardsPerSpace: 2_000,
    maxWhiteboardRestorePointsPerBoard: 250,
    maxStorageBytes: 50 * 1024 * 1024 * 1024, // 50 GB
    recordingEnabled: true,
    streamingEnabled: true,
    pdfExportEnabled: true,
    aiFeaturesEnabled: true,
    customPersonalMeetingCode: true,
  },
  organization: {
    maxParticipants: null,
    maxConcurrentMeetings: null,
    maxMeetingDurationMinutes: null,
    maxSpaces: null,
    maxMembersPerSpace: null,
    maxWhiteboardsPerSpace: 10_000,
    maxWhiteboardRestorePointsPerBoard: 1_000,
    maxStorageBytes: null, // unlimited
    recordingEnabled: true,
    streamingEnabled: true,
    pdfExportEnabled: true,
    aiFeaturesEnabled: true,
    customPersonalMeetingCode: true,
  },
};

export function getPlanLimits(plan: SubscriptionTier): PlanLimits {
  return PLAN_LIMITS[plan];
}

/** A plan's meeting-length limit, for pricing and plan pages. */
export function formatPlanDuration(minutes: number | null): string {
  if (minutes === null) return "Unlimited";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours} hours`;
}
