/**
 * Shared thread-projection types for the inbox. The server queries produce
 * these rows and the client renders them, so the shapes live in the contract
 * layer where both ownership domains can read them.
 */

export interface ThreadOpenMeeting {
  meetingId: string;
  code: string;
  title: string | null;
  startedAt: string | null;
  participantCount: number;
}

export interface ThreadLatestMeeting {
  meetingId: string;
  code: string;
  title: string | null;
  startedAt: string | null;
  endedAt: string | null;
  hasSummary: boolean;
}

interface ThreadBase {
  /** meetingLinks.id for personal scopes, spaces.id for Spaces, meetings.id for ad-hoc active Meetings. */
  id: string;
  title: string;
  /** The open Meeting for this link or Space, if any. */
  openMeeting: ThreadOpenMeeting | null;
  latestMeeting: ThreadLatestMeeting | null;
  /** Most recent signal on this thread; drives inbox ordering. */
  lastActivityAt: string | null;
}

export type Thread = ThreadBase &
  (
    | {
        kind: "personal";
        slug: null;
        code: string;
        defaultTitle: string | null;
        joinPolicy: "open" | "approval_required" | "closed";
      }
    | { kind: "space"; slug: string; code: null }
    | { kind: "meeting"; slug: null; code: string }
  );
