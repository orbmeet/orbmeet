// Kept apart from `import-pdf` so the toolbar can recognise the error without
// pulling the lazily loaded importer into the toolbar's chunk.

/**
 * An import that stopped partway with pages already on the whiteboard.
 *
 * Cleanup deliberately keeps pages that were placed — they are live shapes the
 * board owns now, not staged bytes to roll back — so "Import failed" was a lie
 * that cost the user real work: they retried, and the retry placed a second
 * copy of everything the first run had landed. The count travels with the
 * error so the caller can say what is already there and let the user decide.
 */
export class PdfImportPartialError extends Error {
  constructor(readonly pagesImported: number, cause: Error) {
    super(
      `${cause.message} ${pagesImported} page${pagesImported === 1 ? "" : "s"} ` +
      `already landed on the whiteboard — remove them before importing again.`,
    );
    this.name = "PdfImportPartialError";
    this.cause = cause;
  }
}
