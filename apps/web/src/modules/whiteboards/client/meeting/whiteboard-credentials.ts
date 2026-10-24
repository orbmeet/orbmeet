import { decodeBase64Url } from "@orbmeet/primitives";
import type { WhiteboardConnectAttempt } from "@orbmeet/whiteboard-client/react";
import {
  WHITEBOARD_TOKEN_REFRESH_BUFFER_MS,
  type WhiteboardAccessState,
} from "@/modules/whiteboards/client/meeting/whiteboard-access-state";

/**
 * A socket that keeps failing without ever coming online reuses its token for
 * this long before minting another: a sync-server outage costs each client
 * one mint per window, not one per reconnect attempt.
 */
export const REMINT_WHILE_OFFLINE_MS = 30_000;

export interface MintedWhiteboardAccess {
  token: string;
  whiteboardUrl: string;
  documentId: string;
  documentTitle: string;
}

/** One document credential, and what it was minted against. */
export interface WhiteboardCredential {
  access: WhiteboardAccessState;
  documentId: string;
  documentTitle: string | null;
  /**
   * The surface revision current when it was requested. The server mints for
   * the board it presents at that moment, so a credential minted at or after
   * a revision is the truth for it even when room metadata still lags.
   */
  revision: number;
  mintedAt: number;
}

export interface WhiteboardCredentialsOptions {
  connectionId: string;
  /** The document credential the join handed over, if the surface was open. */
  initial: { token: string | null; url: string | null; documentId: string | null; documentTitle: string | null };
  mint: () => Promise<MintedWhiteboardAccess>;
  onChange: () => void;
  now?: () => number;
}

/**
 * The credential half of a whiteboard session: which document token this
 * participant holds, and whether it is still good for what the meeting shows.
 *
 * There is no fencing: a mint answers for the revision it was requested at,
 * and whether that is good enough is decided by comparing, never by
 * remembering which request came last.
 */
export class WhiteboardCredentials {
  private currentValue: WhiteboardCredential | null;
  private inFlight: Promise<WhiteboardCredential> | null = null;
  /** A healthy socket dropped since the last mint; its authority may have changed. */
  private droppedSinceMint = false;
  private wasOnline = false;
  private minted = false;
  private readonly now: () => number;

  constructor(private readonly options: WhiteboardCredentialsOptions) {
    this.now = options.now ?? Date.now;
    const { token, url, documentId, documentTitle } = options.initial;
    this.currentValue = token && url && documentId
      ? { access: accessFromToken(token, url), documentId, documentTitle, revision: -1, mintedAt: this.now() }
      : null;
  }

  get current(): WhiteboardCredential | null {
    return this.currentValue;
  }

  /** Minted successfully at least once: the whiteboard service is reachable. */
  get recovered(): boolean {
    return this.minted;
  }

  get minting(): boolean {
    return this.inFlight !== null;
  }

  /**
   * Whether the held credential serves the surface at `revision` showing
   * `whiteboardId`: bound to this connection, unexpired, and for that board.
   */
  isUsableFor(surface: { whiteboardId: string | null; revision: number }): boolean {
    const credential = this.currentValue;
    if (!credential) return false;
    const { access } = credential;
    if (!access.participantBound || access.connectionId !== this.options.connectionId) return false;
    if (!access.expiresAt || this.now() >= access.expiresAt) return false;
    return credential.documentId === surface.whiteboardId || credential.revision >= surface.revision;
  }

  /** When the held credential should be replaced ahead of its expiry, if it expires. */
  get refreshAt(): number | null {
    const expiresAt = this.currentValue?.access.expiresAt;
    return expiresAt ? expiresAt - WHITEBOARD_TOKEN_REFRESH_BUFFER_MS : null;
  }

  /** Mint for the surface at `revision`. Concurrent callers share one request. */
  mint(revision: number): Promise<WhiteboardCredential> {
    if (this.inFlight) return this.inFlight;
    const request = this.options
      .mint()
      .then((minted) => {
        const credential: WhiteboardCredential = {
          access: accessFromToken(minted.token, minted.whiteboardUrl),
          documentId: minted.documentId,
          documentTitle: minted.documentTitle,
          revision,
          mintedAt: this.now(),
        };
        // Only a newer answer replaces the held one.
        if (!this.currentValue || this.currentValue.revision <= revision) this.currentValue = credential;
        this.minted = true;
        this.droppedSinceMint = false;
        this.options.onChange();
        return credential;
      })
      .finally(() => {
        this.inFlight = null;
      });
    this.inFlight = request;
    return request;
  }

  /**
   * The URI for one sync-adapter connection attempt. The held token is reused
   * unless it no longer serves the surface, the socket it was used on was
   * closed after coming online (a capability change closes sockets), the
   * sync server just rejected it as stale, or it has kept failing to come
   * online for a while.
   */
  async webSocketUri(
    surface: { whiteboardId: string | null; revision: number },
    attempt?: WhiteboardConnectAttempt,
  ): Promise<string> {
    const held = this.currentValue;
    const stale = !held
      || !this.isUsableFor(surface)
      || this.now() >= (this.refreshAt ?? 0)
      || this.droppedSinceMint
      // The server read these claims against D1 and found them out of date. A
      // rejected socket may never report "online", so the drop above cannot be
      // relied on to catch it; resending the token only earns the same answer.
      || attempt?.tokenRejected === true
      || (!this.wasOnline && this.now() - held.mintedAt >= REMINT_WHILE_OFFLINE_MS);
    const credential = stale ? await this.mint(surface.revision) : held;
    const { token, whiteboardUrl } = credential.access;
    if (!token || !whiteboardUrl) throw new Error("Whiteboard connection is unavailable");
    const url = new URL("/connect", whiteboardUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.hash = new URLSearchParams({ token }).toString();
    return url.toString();
  }

  /** The canvas reports its socket. Returns whether the session should re-render. */
  connectionStatusChanged(status: "online" | "offline"): boolean {
    if (status === "online") {
      const changed = !this.wasOnline;
      this.wasOnline = true;
      return changed;
    }
    // "Offline" before the first connection is only the board still loading.
    if (!this.wasOnline) return false;
    this.wasOnline = false;
    this.droppedSinceMint = true;
    return true;
  }

  get online(): boolean {
    return this.wasOnline;
  }
}

function accessFromToken(token: string, whiteboardUrl: string): WhiteboardAccessState {
  const claims = readTokenClaims(token);
  return {
    token,
    whiteboardUrl,
    expiresAt: claims?.expiresAt ?? null,
    connectionId: claims?.connectionId ?? null,
    participantBound: !!claims?.connectionId || claims?.service === "recorder",
    canEditWhiteboard: claims?.canEditWhiteboard ?? false,
    canManageWhiteboard: claims?.canManageWhiteboard ?? false,
  };
}

/** The claims the client acts on. The server verifies the token; this only reads it. */
function readTokenClaims(token: string): {
  expiresAt: number | null;
  connectionId: string | null;
  service: string | null;
  canEditWhiteboard: boolean;
  canManageWhiteboard: boolean;
} | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const bytes = decodeBase64Url(payload);
    if (!bytes) return null;
    const decoded = JSON.parse(new TextDecoder().decode(bytes)) as {
      exp?: number;
      connectionId?: string;
      service?: string;
      capabilities?: { canEditWhiteboard?: boolean; canManageWhiteboard?: boolean };
    };
    return {
      expiresAt: typeof decoded.exp === "number" ? decoded.exp * 1000 : null,
      connectionId: typeof decoded.connectionId === "string" ? decoded.connectionId : null,
      service: typeof decoded.service === "string" ? decoded.service : null,
      canEditWhiteboard: decoded.capabilities?.canEditWhiteboard === true,
      canManageWhiteboard: decoded.capabilities?.canManageWhiteboard === true,
    };
  } catch {
    return null;
  }
}
