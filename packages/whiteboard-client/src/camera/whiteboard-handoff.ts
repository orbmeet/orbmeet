/**
 * How long a hand-off waits for the person it was handed to to be able to
 * write. Giving someone edit access moves them onto a writing connection,
 * which takes a moment; until it lands the room refuses to make them the
 * presenter.
 */
const HANDOFF_GRANT_WAIT_MS = 10_000;
const HANDOFF_RETRY_MS = 500;

export interface HandoffTarget {
  userId: string;
  userName: string;
  /** Their grant principal; needed to give them edit access. */
  principalKey?: string;
  /** Whether they can write already. Unknown (an older room) is treated as yes. */
  canEdit?: boolean;
}

/**
 * Hand the board to `target`: give them edit access first when they cannot
 * write yet — presenting is writing on the board everyone follows, and the
 * room will not make a reader the presenter — then make them the presenter,
 * trying again while their access arrives.
 *
 * Returns null when they are presenting, or what went wrong, said for the
 * person who asked.
 */
export async function handOffBoard(
  target: HandoffTarget,
  {
    grant,
    setController,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    grantWaitMs = HANDOFF_GRANT_WAIT_MS,
  }: {
    grant?: (principalKey: string) => Promise<unknown>;
    setController: (userId: string) => Promise<unknown>;
    wait?: (ms: number) => Promise<unknown>;
    grantWaitMs?: number;
  },
): Promise<string | null> {
  const needsAccess = target.canEdit === false;
  if (needsAccess) {
    if (!grant || !target.principalKey) {
      return `${target.userName} can't write on the board yet. Give them edit access first.`;
    }
    try {
      await grant(target.principalKey);
    } catch {
      return `Couldn't give ${target.userName} edit access.`;
    }
  }

  let waited = 0;
  for (;;) {
    try {
      await setController(target.userId);
      return null;
    } catch {
      if (!needsAccess || waited >= grantWaitMs) {
        return `Couldn't hand the board to ${target.userName}.`;
      }
      await wait(HANDOFF_RETRY_MS);
      waited += HANDOFF_RETRY_MS;
    }
  }
}
