import type { Keyring } from "@orbmeet/primitives";
import { postSignedJson } from "./app-client.ts";
import {
  MAX_AUTHORITY_CLAIMS,
  ROOM_AUTHORITY_PATH,
  type AuthorityClaim,
  type AuthorityVerdict,
  type RoomAuthorityRequest,
} from "@orbmeet/whiteboard-core/sync-commands";
import type { WhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";
import { logWarn } from "../lib/log.ts";

const AUTHORITY_TIMEOUT_MS = 5_000;
const VERDICTS: ReadonlySet<string> = new Set<AuthorityVerdict>(["active", "refresh", "denied"]);

/** Asks the Worker — D1's owner — whether the claims a room is holding are still current. */
export interface AuthorityValidator {
  /**
   * `generation` is the board generation the asker holds (a room) or was
   * minted for (a token): every claim is stale once the board has moved on.
   */
  verdicts(
    whiteboardRoomId: WhiteboardRoomId,
    claims: AuthorityClaim[],
    generation?: number,
  ): Promise<AuthorityVerdict[] | "unavailable">;
}

export function createAuthorityClient(options: {
  appUrl: string;
  keyring: Keyring;
  fetch?: typeof fetch;
}): AuthorityValidator {
  const url = new URL(ROOM_AUTHORITY_PATH, options.appUrl);
  const send = options.fetch ?? fetch;

  /** One signed request for at most `MAX_AUTHORITY_CLAIMS` claims. */
  async function ask(
    whiteboardRoomId: WhiteboardRoomId,
    claims: AuthorityClaim[],
    generation: number | undefined,
  ): Promise<AuthorityVerdict[] | "unavailable"> {
    const body: RoomAuthorityRequest = generation === undefined
      ? { whiteboardRoomId, claims }
      : { whiteboardRoomId, generation, claims };
    try {
      const response = await postSignedJson(url, body, options.keyring, AUTHORITY_TIMEOUT_MS, send);
      if (!response.ok) {
        logWarn(`[authority] ${whiteboardRoomId}: Worker answered ${response.status}`);
        return "unavailable";
      }
      const parsed = (await response.json()) as { verdicts?: unknown };
      const verdicts = parsed.verdicts;
      if (
        !Array.isArray(verdicts)
        || verdicts.length !== claims.length
        || !verdicts.every((verdict) => typeof verdict === "string" && VERDICTS.has(verdict))
      ) {
        logWarn(`[authority] ${whiteboardRoomId}: malformed verdicts`);
        return "unavailable";
      }
      return verdicts as AuthorityVerdict[];
    } catch (error) {
      logWarn(`[authority] ${whiteboardRoomId}: request failed`, error);
      return "unavailable";
    }
  }

  return {
    // A room holding more claims than one request carries asks in several.
    // Any part unanswered leaves the whole sweep unanswered, so the room's
    // stale-allow window still bounds how long nobody is checked.
    async verdicts(whiteboardRoomId, claims, generation) {
      const chunks: AuthorityClaim[][] = [];
      for (let start = 0; start < claims.length; start += MAX_AUTHORITY_CLAIMS) {
        chunks.push(claims.slice(start, start + MAX_AUTHORITY_CLAIMS));
      }
      const answers = await Promise.all(chunks.map((chunk) => ask(whiteboardRoomId, chunk, generation)));
      const verdicts: AuthorityVerdict[] = [];
      for (const answer of answers) {
        if (answer === "unavailable") return "unavailable";
        verdicts.push(...answer);
      }
      return verdicts;
    },
  };
}
