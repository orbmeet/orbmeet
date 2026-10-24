import type { AssistantPageContext } from "./protocol.ts";

/**
 * What Orb was shown with a question, kept on the question so everyone who
 * reads the answer can see what it stood on. Facts only — no page content —
 * since an answer can be read by people who could not see the asker's view.
 */
export interface AssistantLookedAt {
  pageNumber: number;
  pageCount: number;
  /** The presenter the asker was following, whose page `pageNumber` is. */
  following?: string;
  /** How many pages the outline of the whole board covered. */
  outlinePages?: number;
  /** Whether a picture of the page went with it, not only its shapes. */
  picture?: boolean;
  /** Whether what was said lately went with it. */
  said?: boolean;
}

export function lookedAtFromRequest(page: AssistantPageContext, said: string | undefined): AssistantLookedAt {
  return {
    pageNumber: page.pageNumber,
    pageCount: page.pageCount,
    ...(page.following ? { following: page.following.presenterName } : {}),
    ...(page.outline?.length ? { outlinePages: page.outline.length } : {}),
    ...(page.screenshot ? { picture: true } : {}),
    ...(said?.trim() ? { said: true } : {}),
  };
}

/**
 * One line under an answer: "Looked at page 4 of 7 (Atiq's page), an outline
 * of all 7 pages and what was said lately."
 */
export function describeLookedAt(lookedAt: AssistantLookedAt): string {
  const page =
    lookedAt.pageCount === 1
      ? "the page"
      : `page ${lookedAt.pageNumber} of ${lookedAt.pageCount}${lookedAt.following ? ` (${lookedAt.following}’s page)` : ""}`;
  const parts = [page];
  if (lookedAt.outlinePages && lookedAt.pageCount > 1) {
    parts.push(
      lookedAt.outlinePages >= lookedAt.pageCount
        ? `an outline of all ${lookedAt.pageCount} pages`
        : `an outline of ${lookedAt.outlinePages} pages`,
    );
  }
  if (lookedAt.said) parts.push("what was said lately");
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `Looked at ${list}.`;
}
