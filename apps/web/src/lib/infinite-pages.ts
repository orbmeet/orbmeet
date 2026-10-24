import type { InfiniteData } from "@tanstack/react-query";

/**
 * For a list paged on a key that can change between pages: a row whose key
 * moved past the cursor is served again by a later page, fetched after the
 * move. That copy is the current one, so each row is kept once, in the page
 * fetched last that holds it. (A row that moved the other way is skipped
 * until the list is next refetched from its first page.)
 */
export function keepLastCopyPerId<
  const Field extends string,
  TPage extends { readonly [F in Field]: ReadonlyArray<{ id: string }> },
  TParam,
>(data: InfiniteData<TPage, TParam>, field: Field): InfiniteData<TPage, TParam> {
  const seen = new Set<string>();
  const pages = [...data.pages].reverse().map((page): TPage => ({
    ...page,
    [field]: page[field].filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    }),
  }));
  return { ...data, pages: pages.reverse() };
}
