/**
 * Past this the parse costs more than the number is worth on a tablet: the
 * whole document is read into memory just to count it.
 */
const COUNT_MAX_BYTES = 20 * 1024 * 1024;

/**
 * How many pages a PDF chosen from the device has, or null when that can't be
 * told cheaply (too large, damaged, or not a PDF the parser understands).
 *
 * The page-range dialog asks "from page … to page …" of a document it had
 * never looked at; this is what lets it say how many there are.
 */
export async function countPdfPages(file: File): Promise<number | null> {
  if (file.size > COUNT_MAX_BYTES) return null;
  try {
    const { PDFDocument } = await import("pdf-lib");
    const document = await PDFDocument.load(await file.arrayBuffer(), {
      ignoreEncryption: true,
      updateMetadata: false,
    });
    const count = document.getPageCount();
    return count > 0 ? count : null;
  } catch {
    return null;
  }
}
