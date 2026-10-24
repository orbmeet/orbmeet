import { useMemo } from "react";
import { type TLStore, type TLUserStore } from "tldraw";
import { atom, computed, type Atom } from "@tldraw/state";
import { createCachedUserResolve, createUserId, UserRecordType } from "@tldraw/tlschema";
import { base64urlDecode } from "@orbmeet/whiteboard-core/crypto-utils";
import { userColorForId } from "../editor/whiteboard-editor-internals";

export interface WhiteboardIdentity {
  userId: string | null;
  userName: string;
  isHost: boolean;
  error: string | null;
}

/** Exported for tests; the hook is the only production caller. */
export function decodeWhiteboardJwt(token: string): WhiteboardIdentity {
  try {
    const parts = token.split(".");
    if (parts.length === 3) {
      // JWT payloads are UTF-8. atob() yields one char per *byte*, so decoding
      // through it alone mangles every non-ASCII display name into mojibake —
      // and this name is what labels the user's cursor for everyone else.
      const payload = JSON.parse(
        new TextDecoder().decode(base64urlDecode(parts[1])),
      );
      const capabilities = payload.capabilities && typeof payload.capabilities === "object"
        ? payload.capabilities as { canManageWhiteboard?: unknown }
        : null;
      return {
        userId: typeof payload.sub === "string" ? payload.sub : null,
        userName: typeof payload.name === "string" ? payload.name : "",
        isHost: capabilities?.canManageWhiteboard === true,
        error: null,
      };
    }
  } catch (err) {
    console.error("[WB] Failed to decode JWT:", err);
  }
  return {
    userId: null,
    userName: "",
    isHost: false,
    error: "Whiteboard token is invalid.",
  };
}

/**
 * Who is who on the board, for tldraw: this client's user, and everyone else
 * as their presence names them.
 *
 * tldraw names the author of a note's text by asking `resolve` first and
 * falling back to the `user:` records in the shared document. Presence is the
 * better source: the room stamps each session's presence with the identity
 * its token carries, so a name read from it is one nobody else could have
 * written. Someone who has left the board falls through to their `user:`
 * record, which the room only lets them write as themselves.
 */
export interface WhiteboardUserDirectory {
  users: TLUserStore;
  /** The board's store, once sync has made it: where `resolve` reads presence. */
  store: Atom<TLStore | null>;
}

function createUserDirectory(userIdValue: string | null, userName: string): WhiteboardUserDirectory | undefined {
  if (!userIdValue || typeof window === "undefined") return undefined;

  const rawUserId = userIdValue;
  const displayName = userName || "User";
  const userId = createUserId(rawUserId);
  const store = atom<TLStore | null>(`orbmeet-user-directory-store:${rawUserId}`, null);
  const currentUser = computed(`orbmeet-current-user:${rawUserId}`, () =>
    UserRecordType.create({
      id: userId,
      name: displayName,
      color: userColorForId(rawUserId),
    })
  );

  return {
    store,
    users: {
      currentUser,
      resolve: createCachedUserResolve((id) => {
        if (id === rawUserId) return currentUser.get();
        const presenceUserId = createUserId(id);
        const presence = store
          .get()
          ?.query.records("instance_presence")
          .get()
          .find((record) => record.userId === presenceUserId);
        return presence
          ? UserRecordType.create({ id: presenceUserId, name: presence.userName, color: presence.color })
          : null;
      }),
    },
  };
}

export function useWhiteboardIdentity(token: string): {
  identity: WhiteboardIdentity;
  directory: WhiteboardUserDirectory | undefined;
} {
  const identity = useMemo(() => decodeWhiteboardJwt(token), [token]);
  const directory = useMemo(
    () => createUserDirectory(identity.userId, identity.userName),
    [identity.userId, identity.userName],
  );

  return { identity, directory };
}
