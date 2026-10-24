/**
 * How a Meeting's stored follow-ups change when its Summary is written again.
 *
 * A follow-up is something people act on — ticked off, perhaps by someone
 * else, from a page that is still open — so a new list never simply replaces
 * the old one. Each new item takes over the stored row it repeats, keeping its
 * id and whether it was done; the model rewords freely between runs, so
 * "repeats" means the same words in any order, near enough. Done work the new
 * list no longer mentions stays, after it: it happened. Only open items that
 * nobody repeated go.
 */

export interface StoredFollowUp {
  id: string;
  text: string;
  done: boolean;
}

export interface FollowUpDraft {
  text: string;
  ownerName: string | null;
}

export interface FollowUpPlan {
  /** Rows kept under their id, with the text, owner and place they now have. */
  keep: Array<{ id: string; text: string; ownerName: string | null; position: number; rewritten: boolean }>;
  /** New rows, at their place. */
  add: Array<FollowUpDraft & { position: number }>;
  /** Open rows the new list does not repeat. */
  remove: string[];
}

/** How alike two wordings must be, as shared words over all words, to be one task. */
const SAME_TASK = 0.6;

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
}

function likeness(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export function planFollowUps(previous: readonly StoredFollowUp[], next: readonly FollowUpDraft[]): FollowUpPlan {
  const plan: FollowUpPlan = { keep: [], add: [], remove: [] };
  const unclaimed = previous.map((row) => ({ row, words: words(row.text) }));

  next.forEach((draft, position) => {
    const draftWords = words(draft.text);
    // The most alike row that clears the bar; the earlier one on a tie.
    let best = -1;
    let bestLikeness = 0;
    unclaimed.forEach((candidate, index) => {
      const score = likeness(draftWords, candidate.words);
      if (score >= SAME_TASK && score > bestLikeness) {
        best = index;
        bestLikeness = score;
      }
    });
    if (best === -1) {
      plan.add.push({ ...draft, position });
      return;
    }
    const [{ row }] = unclaimed.splice(best, 1);
    plan.keep.push({ id: row.id, text: draft.text, ownerName: draft.ownerName, position, rewritten: true });
  });

  let position = next.length;
  for (const { row } of unclaimed) {
    if (row.done) plan.keep.push({ id: row.id, text: row.text, ownerName: null, position: position++, rewritten: false });
    else plan.remove.push(row.id);
  }
  return plan;
}
