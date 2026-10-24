import {
  authorityClaimKey,
  type AuthorityClaim,
  type SyncCommandResult,
} from "@orbmeet/whiteboard-core/sync-commands";
import type { WhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";
import type { AuthorityValidator } from "../http/authority-client.ts";
import type { WhiteboardJWTClaims } from "@orbmeet/whiteboard-core/whiteboard-jwt";
import { whiteboardGrantPrincipalKey } from "@orbmeet/whiteboard-core/whiteboard-grant-principal";
import type { LiveConnection } from "./room-connections.ts";
import type { SessionMeta } from "./room-types.ts";
import { logError, logWarn } from "../lib/log.ts";

/**
 * How long a room keeps serving its sockets while the Worker cannot answer
 * authority. Past it the room closes them transiently, and admission refuses
 * until the Worker is back.
 */
const AUTHORITY_STALE_ALLOW_MS = 120_000;

/** Manages the board by its role. A suspended session manages nothing until its verdict lands. */
export function isBaseManager(meta: Pick<SessionMeta, "capabilities" | "writesSuspended">): boolean {
  return !meta.writesSuspended && meta.capabilities.canManageWhiteboard;
}

export function canEditWhiteboardForMeta(meta: SessionMeta): boolean {
  if (meta.writesSuspended) return false;
  return isBaseManager(meta) || meta.capabilities.canEditWhiteboard;
}

/** What the authority owner needs from the room around it. */
export interface RoomAuthorityHost {
  whiteboardRoomId: WhiteboardRoomId;
  validator: AuthorityValidator;
  /** The board generation this room holds; the Worker refreshes everyone once the board has moved on. */
  generation(): number;
  liveConnections(): LiveConnection[];
  /** Every admitted session, including one whose socket has not closed yet. */
  sessionMetas(): Iterable<SessionMeta>;
  sessionMeta(tldrawSessionId: string): SessionMeta | undefined;
  isClosed(): boolean;
  /** The session's claims went stale: reconnect it so the client re-mints its token. */
  reconnect(tldrawSessionId: string): void;
  /** The session no longer belongs: close it for good. */
  deny(tldrawSessionId: string): void;
  /** The Worker stayed unreachable past `AUTHORITY_STALE_ALLOW_MS`. */
  disconnectAll(): void;
  stateChanged(): void;
}

/**
 * Who may do what in a room.
 *
 * D1 owns authority; the room holds none of its own. A session's capabilities
 * are exactly the claims of the token it connected with, and the Worker's
 * verdicts decide whether those claims are still current (`revalidate`). Any
 * change — a grant, a revoke, a role change — makes the claims stale, and the
 * socket reconnects with a freshly minted token. The only mutable input is
 * `writesSuspended`: the short window between the Worker narrowing a
 * principal's authority and its verdict arriving.
 */
export class RoomAuthority {
  // Verdicts apply in request order: a sweep that started before a D1 change
  // must not overwrite the verdict of one that started after it.
  private requestSequence = 0;
  private appliedSequence = 0;
  private unavailableSince: number | null = null;
  private checkRunning = false;

  private readonly host: RoomAuthorityHost;

  constructor(host: RoomAuthorityHost) {
    this.host = host;
  }

  isBaseManager(meta: Pick<SessionMeta, "capabilities" | "writesSuspended">): boolean {
    return isBaseManager(meta);
  }

  canEditWhiteboardForMeta(meta: SessionMeta): boolean {
    return canEditWhiteboardForMeta(meta);
  }

  canManageWhiteboard(userId: string): boolean {
    return this.host.liveConnections().some(
      ({ meta }) => meta.userId === userId && isBaseManager(meta),
    );
  }

  canUserEditWhiteboard(userId: string): boolean {
    return this.host.liveConnections().some(
      ({ meta }) => meta.userId === userId && canEditWhiteboardForMeta(meta),
    );
  }

  /** Principals holding edit access through a grant rather than their role. */
  grantedEditorPrincipalKeys(): string[] {
    const keys = new Set<string>();
    for (const { meta } of this.host.liveConnections()) {
      if (!isBaseManager(meta) && canEditWhiteboardForMeta(meta)) {
        keys.add(meta.grantPrincipalKey);
      }
    }
    return [...keys];
  }

  /** Room-manager tick: re-verify every socket's authority. Skips itself while a check runs. */
  tick(): void {
    if (this.host.isClosed() || this.checkRunning || this.host.liveConnections().length === 0) return;
    this.checkRunning = true;
    void this.revalidate()
      .catch((error) => {
        logError(`[Room ${this.host.whiteboardRoomId}] Authority check failed:`, error);
      })
      .finally(() => {
        this.checkRunning = false;
      });
  }

  /**
   * Ask the Worker whether every live socket's claims are still current, and
   * act on the answer: `refresh` reconnects the socket so the client re-mints
   * its token, `denied` closes it for good. Token expiry is deliberately not
   * checked — an active participant keeps a socket while D1 says they belong.
   */
  async revalidate(): Promise<void> {
    const groups = new Map<string, { claim: AuthorityClaim; sessionIds: string[] }>();
    for (const { tldrawSessionId, meta } of this.host.liveConnections()) {
      const claim = authorityClaimForSession(meta);
      const key = authorityClaimKey(claim);
      const group = groups.get(key);
      if (group) group.sessionIds.push(tldrawSessionId);
      else groups.set(key, { claim, sessionIds: [tldrawSessionId] });
    }
    if (groups.size === 0) return;

    const sequence = ++this.requestSequence;
    const entries = [...groups.values()];
    const verdicts = await this.host.validator.verdicts(
      this.host.whiteboardRoomId,
      entries.map((entry) => entry.claim),
      this.host.generation(),
    );
    if (this.host.isClosed()) return;
    if (verdicts === "unavailable") {
      this.handleUnavailable();
      return;
    }
    this.unavailableSince = null;
    if (sequence <= this.appliedSequence) return;
    this.appliedSequence = sequence;

    let changed = false;
    entries.forEach(({ sessionIds }, index) => {
      const verdict = verdicts[index];
      for (const sessionId of sessionIds) {
        const meta = this.host.sessionMeta(sessionId);
        if (!meta) continue;
        if (verdict === "active") {
          if (meta.writesSuspended) {
            meta.writesSuspended = false;
            changed = true;
          }
        } else if (verdict === "refresh") {
          this.host.reconnect(sessionId);
        } else {
          this.host.deny(sessionId);
        }
      }
    });
    if (changed) this.host.stateChanged();
  }

  /**
   * The Worker just changed D1 authority for this room. With a principal, its
   * sessions stop writing and managing until the fresh verdict lands — a
   * revoke takes effect at once, not at the end of a round trip. A managing
   * session is suspended too: the change may have taken its role.
   */
  refresh(principalKey?: string): SyncCommandResult<"refreshAuthority"> {
    // Verdicts already in flight read D1 before this change and must not
    // land after it: an "active" one would lift the suspension below.
    this.appliedSequence = this.requestSequence;
    if (principalKey) {
      let suspended = false;
      for (const meta of this.host.sessionMetas()) {
        if (meta.grantPrincipalKey !== principalKey) continue;
        meta.writesSuspended = true;
        suspended = true;
      }
      if (suspended) this.host.stateChanged();
    }
    void this.revalidate().catch((error) => {
      logError(`[Room ${this.host.whiteboardRoomId}] Authority refresh failed:`, error);
    });
    return { ok: true, status: "scheduled" };
  }

  /**
   * Whether a live socket was admitted with exactly `claim` and is still
   * verified — the sweep closes any whose claims went stale. Browser routes use
   * it to skip a round trip for a token the room already vouches for.
   */
  holdsVerifiedClaim(claim: AuthorityClaim): boolean {
    if (this.unavailableSince !== null) return false;
    const key = authorityClaimKey(claim);
    return this.host.liveConnections().some(
      ({ meta }) => !meta.writesSuspended && authorityClaimKey(authorityClaimForSession(meta)) === key,
    );
  }

  private handleUnavailable(): void {
    const now = Date.now();
    this.unavailableSince ??= now;
    if (now - this.unavailableSince < AUTHORITY_STALE_ALLOW_MS) return;
    logWarn(
      `[Room ${this.host.whiteboardRoomId}] Authority unavailable for ${AUTHORITY_STALE_ALLOW_MS}ms; closing sockets`,
    );
    this.host.disconnectAll();
  }
}

/** The claim a session was admitted with, in the shape the Worker validates. */
function authorityClaimForSession(meta: SessionMeta): AuthorityClaim {
  return {
    sub: meta.userId,
    role: meta.role,
    connectionId: meta.connectionId,
    grantPrincipalKey: meta.grantPrincipalKey,
    capabilities: { ...meta.capabilities },
    ...(meta.service ? { service: meta.service } : {}),
    ...(meta.documentId ? { documentId: meta.documentId } : {}),
  };
}

/** The claim a verified token makes, before any socket exists for it. */
export function authorityClaimForToken(claims: WhiteboardJWTClaims): AuthorityClaim {
  return {
    sub: claims.sub,
    role: claims.role,
    connectionId: claims.connectionId,
    grantPrincipalKey: whiteboardGrantPrincipalKey(claims.grantPrincipal),
    capabilities: { ...claims.capabilities },
    ...(claims.service ? { service: claims.service } : {}),
    ...(claims.documentId ? { documentId: claims.documentId } : {}),
  };
}
