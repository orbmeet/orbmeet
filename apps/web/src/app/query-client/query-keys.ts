/**
 * Query key factory for consistent cache management.
 * Auth identity changes (login, verify, logout) call resetAuthQueryCache because
 * Router invalidation does not remove user-scoped Query data.
 */
export const queryKeys = {
  status: () => ["status"] as const,
  clientMeetingHints: () => ["client-meeting-hints"] as const,
  session: () => ["session"] as const,
  rememberedUser: () => ["remembered-user"] as const,
  participantHandoff: (meetingId: string, admissionId: string) =>
    ["participant-handoff", meetingId, admissionId] as const,
  participantHandoffWhiteboard: (meetingId: string, admissionId: string, whiteboardId: string | undefined) =>
    ["participant-handoff", meetingId, admissionId, "whiteboard", whiteboardId] as const,
  accountDeletionPending: () => ["account-deletion-pending"] as const,
  threads: () => ["threads"] as const,
  meetings: {
    // The landing page's "rejoin your last Meeting" shortcut. Reusable links only,
    // so it never collides with one-time meeting history.
    lastReusable: () => ["meetings", "last-reusable"] as const,
    list: <T>(input: T) => ["meetings", "list", input] as const,
    lists: () => ["meetings", "list"] as const,
    attendance: (meetingId: string) => ["meetings", meetingId, "attendance"] as const,
    upcomingSchedules: (spaceId?: string) => spaceId
      ? (["meetings", "scheduled", "upcoming", "space", spaceId] as const)
      : (["meetings", "scheduled", "upcoming"] as const),
    // What happened last time at this link, shown before joining it again.
    previousSession: (code: string | undefined) => ["meetings", "previous-session", code] as const,
    summary: (meetingId: string) => ["meetings", "summary", meetingId] as const,
    summaries: () => ["meetings", "summary"] as const,
    transcripts: (meetingId: string) => ["meetings", "transcripts", meetingId] as const,
    // Library search: lines said in past meetings that match the search text.
    spoken: <T>(input: T) => ["meetings", "spoken", input] as const,
    // Follow-ups still open across the viewer's recent meetings (Home).
    openFollowUps: () => ["meetings", "follow-ups", "open"] as const,
  },
  whiteboards: {
    list: (status?: "active" | "archived") => status
      ? (["whiteboards", "list", status] as const)
      : (["whiteboards", "list"] as const),
    details: () => ["whiteboards", "detail"] as const,
    detail: (whiteboardId: string) => [...queryKeys.whiteboards.details(), whiteboardId] as const,
    meetingChoices: (meetingId: string) =>
      ["whiteboards", "meeting-choices", meetingId] as const,
    meetingChoiceSearch: (meetingId: string, search: string) =>
      [...queryKeys.whiteboards.meetingChoices(meetingId), search] as const,
    standaloneAccess: (whiteboardId: string) =>
      ["whiteboards", "standalone-access", whiteboardId] as const,
    snapshots: (whiteboardId: string) =>
      ["whiteboards", "snapshots", whiteboardId] as const,
  },
  spaces: {
    // Two deliberately disjoint branches. `all()` is the viewer's spaces list
    // and nothing else — it must NOT be a prefix of the per-space subtree, or
    // "refresh my spaces list" after a delete/leave would refetch the detail and
    // audit queries of the space the viewer just lost access to, throw
    // FORBIDDEN under useSuspenseQuery, and trip the error boundary before the
    // navigation away lands. `scope(id)` is the opposite: the prefix that owns
    // every membership-gated branch, so eviction can drop them in one call.
    all: () => ["spaces", "list"] as const,
    bySlug: (slug: string) => ["spaces", "slug", slug] as const,
    scope: (id: string) => ["spaces", id] as const,
    detail: (id: string) => ["spaces", id, "detail"] as const,
    members: (id: string) => ["spaces", id, "members"] as const,
    meetings: (id: string) => ["spaces", id, "meetings"] as const,
    whiteboards: (id: string) => ["spaces", id, "whiteboards"] as const,
    defaultMeetingLink: (id: string) => ["spaces", id, "default-meeting-link"] as const,
    invite: (id: string) => ["spaces", id, "invite"] as const,
    invitePreview: (token: string) => ["spaces", "invite-preview", token] as const,
    audit: (id: string) => ["spaces", id, "audit"] as const,
  },
  organizations: {
    all: () => ["organizations"] as const,
    detail: (id: string) => ["organizations", id] as const,
    members: (id: string) => ["organizations", id, "members"] as const,
    spaces: (id: string) => ["organizations", id, "spaces"] as const,
  },
  files: {
    bySpace: (spaceId: string) => ["files", "space", spaceId] as const,
  },
  artifacts: {
    recordingPlayback: (artifactId: string) => ["artifacts", "recording", artifactId, "playback"] as const,
  },
  storage: {
    usage: () => ["storage", "usage"] as const,
  },
  linkedAccounts: () => ["linked-accounts"] as const,
  passkeys: () => ["settings", "passkeys"] as const,
  personalAccessTokens: () => ["settings", "personal-access-tokens"] as const,
  sessions: {
    all: () => ["sessions"] as const,
  },
};
