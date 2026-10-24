import type { TLAsset, TLAssetId, TLParentId, TLShape } from "tldraw";
import { CODE_SHAPE_TYPE } from "@orbmeet/whiteboard-core/code-shape-schema";
import { MATH_SHAPE_TYPE } from "@orbmeet/whiteboard-core/math-shape-schema";
import { WHITEBOARD_PAGE_SHAPE_TYPE } from "@orbmeet/whiteboard-core/page-shape-schema";
import { isPdfPageShapeId } from "@orbmeet/whiteboard-core/pdf-page-asset";
import { readShapeAuthor, type ShapeAuthor } from "@orbmeet/whiteboard-core/shape-author";
import { TABLE_SHAPE_TYPE } from "@orbmeet/whiteboard-core/table-shape-schema";

/**
 * Where something on the board came from, in the terms Show sources labels it:
 * words someone typed, marks someone drew, a file brought in, or anything else
 * someone placed.
 */
export type ShapeSourceKind = "typed" | "drawn" | "imported" | "placed";

export interface ShapeSource {
  kind: ShapeSourceKind;
  /** What it is, in the words the toolbar uses for it. */
  label: string;
  /** Who made it, when the board knows. Shapes from before authors were kept have none. */
  author: ShapeAuthor | null;
}

const TYPED: Readonly<Record<string, string>> = {
  text: "Text",
  note: "Sticky note",
  [MATH_SHAPE_TYPE]: "Math",
  [CODE_SHAPE_TYPE]: "Code block",
  [TABLE_SHAPE_TYPE]: "Table",
};

const DRAWN: Readonly<Record<string, string>> = {
  draw: "Pen",
  highlight: "Highlighter",
};

const PLACED: Readonly<Record<string, string>> = {
  geo: "Shape",
  arrow: "Arrow",
  line: "Line",
  frame: "Frame",
};

/** What a label may look up on the board and in the Space around it. */
export interface ShapeSourceLookups {
  getAsset: (id: TLAssetId) => TLAsset | undefined;
  getParent: (id: TLParentId) => { meta: Readonly<Record<string, unknown>> } | undefined;
  /** A Space file's name, once the library has been read; undefined until then or if it can't be. */
  getLibraryFileName: (fileId: string) => string | undefined;
}

/**
 * Describe one shape, or return null for structure that is not content: the
 * board's pages and the groups that only hold other shapes.
 */
export function describeShapeSource(shape: TLShape, board: ShapeSourceLookups): ShapeSource | null {
  if (shape.type === WHITEBOARD_PAGE_SHAPE_TYPE || shape.type === "group") return null;
  const author = readShapeAuthor(shape.meta);
  const typed = TYPED[shape.type];
  if (typed) return { kind: "typed", label: typed, author };
  const drawn = DRAWN[shape.type];
  if (drawn) return { kind: "drawn", label: drawn, author };

  if (shape.type === "image") {
    if (isPdfPageShapeId(shape.id)) return { kind: "imported", label: pdfPageLabel(shape, board), author };
    const assetId = (shape.props as { assetId?: TLAssetId | null }).assetId;
    const props = assetId ? board.getAsset(assetId)?.props : undefined;
    const name = props && "name" in props ? props.name : "";
    return { kind: "imported", label: name ? `Image · ${name}` : "Image", author };
  }
  if (shape.type === "video") return { kind: "imported", label: "Video", author };
  if (shape.type === "bookmark" || shape.type === "embed") return { kind: "imported", label: "Link", author };

  return { kind: "placed", label: PLACED[shape.type] ?? "Shape", author };
}

/**
 * A PDF page's file and page, when the board knows them. A page filed from the
 * Space keeps its file and real page number on its frame; a page uploaded
 * straight from a device keeps neither, so it says only that it was imported
 * rather than guess (its stored name counts from the start of the import, not
 * the PDF, so a partial import would read wrong).
 */
function pdfPageLabel(shape: TLShape, board: ShapeSourceLookups): string {
  const frame = board.getParent(shape.parentId)?.meta;
  const fileId = typeof frame?.sourceFileId === "string" ? frame.sourceFileId : null;
  const page = typeof frame?.sourcePageNumber === "number" ? frame.sourcePageNumber : null;
  if (!fileId || !page) return "Imported PDF";
  const fileName = board.getLibraryFileName(fileId);
  return fileName ? `${fileName} · page ${page}` : `PDF · page ${page}`;
}
