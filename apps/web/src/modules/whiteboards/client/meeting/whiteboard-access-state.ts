/** A document credential is replaced this long before it expires. */
export const WHITEBOARD_TOKEN_REFRESH_BUFFER_MS = 60 * 1000;

/** What the client reads from a whiteboard token. The server verifies it; this only reads it. */
export interface WhiteboardAccessState {
  token: string | null;
  whiteboardUrl: string | null;
  expiresAt: number | null;
  connectionId: string | null;
  participantBound: boolean;
  canEditWhiteboard: boolean;
  canManageWhiteboard: boolean;
}
