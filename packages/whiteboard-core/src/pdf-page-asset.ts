/**
 * How an imported PDF page is named on the board. The room server builds these
 * when it places pages; the client reads the shape id back to know a picture
 * is a PDF page. Keeping both here means a change to one cannot strand the other.
 *
 * The asset name's page number counts from the start of the import, not the
 * PDF: a partial import of pages 5–8 names its first page 1. The real page is
 * kept only for a Space file, on the frame (`sourcePageNumber`).
 */

/** The key under `createShapeId` for page `pageIndex` of import `importId`. */
export function pdfPageShapeKey(importId: string, pageIndex: number): string {
  return `pdf-page-${importId}-${pageIndex}`;
}

/** Whether a shape id is one the PDF importer placed. */
export function isPdfPageShapeId(shapeId: string): boolean {
  return shapeId.startsWith("shape:pdf-page-");
}

/** The image asset name for zero-based page `pageIndex` of `fileName`. */
export function pdfPageAssetName(fileName: string, pageIndex: number): string {
  return `${fileName}-page-${pageIndex + 1}.png`;
}
