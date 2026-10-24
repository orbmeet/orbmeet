/** The last session held on a meeting link, as the doorway shows it. */
export interface PreviousSession {
  meetingId: string;
  title: string | null;
  endedAt: string;
  durationSeconds: number | null;
  participantCount: number | null;
  /** The opening of its summary, or null while there is none. */
  excerpt: string | null;
}
