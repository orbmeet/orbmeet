import { WHITEBOARD_PAGE_SHAPE_TYPE } from "@orbmeet/whiteboard-core/page-shape-schema";

/** How much of a page's words the summary is given, and of all boards together. */
const PAGE_TEXT_MAX_CHARS = 300;
export const BOARD_OUTLINE_MAX_CHARS = 4_000;

const INK_TYPES = new Set(["draw", "highlight", "line"]);
const IMAGE_TYPES = new Set(["image", "video"]);

type StateRecord = Record<string, unknown>;

function isRecord(value: unknown): value is StateRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The plain words of a shape: its text, or the text nodes of its rich text. */
export function shapeWords(props: unknown): string {
  if (!isRecord(props)) return "";
  if (typeof props.text === "string") return props.text.trim();
  const words: string[] = [];
  const walk = (node: unknown) => {
    if (!isRecord(node)) return;
    if (typeof node.text === "string") words.push(node.text);
    if (Array.isArray(node.content)) {
      const before = words.length;
      for (const child of node.content) walk(child);
      // A paragraph ends a line: keep "x = 6" and the next line apart.
      if (node.type === "paragraph" && words.length > before) words.push(" ");
    }
  };
  walk(props.richText);
  return words.join("").replace(/\s+/g, " ").trim();
}

/**
 * One line a page — its words, how much ink, how many images — for every page
 * of a captured board, in page order. What the summary reads besides what was
 * said: a lesson worked through on the board used to be summarised as
 * "nothing substantive was discussed".
 */
export function outlineFromSnapshot(snapshot: unknown, title: string): string[] {
  if (!isRecord(snapshot) || !Array.isArray(snapshot.documents)) return [];
  const shapes: StateRecord[] = [];
  for (const document of snapshot.documents) {
    if (isRecord(document) && isRecord(document.state) && document.state.typeName === "shape") {
      shapes.push(document.state);
    }
  }
  const pages = shapes
    .filter((shape) => shape.type === WHITEBOARD_PAGE_SHAPE_TYPE && typeof shape.id === "string")
    .sort((a, b) => Number(a.y ?? 0) - Number(b.y ?? 0));
  const pageIds = new Set(pages.map((page) => page.id as string));
  const parentOf = new Map(shapes.map((shape) => [shape.id as string, shape.parentId as string | undefined]));
  const pageOf = (shape: StateRecord): string | null => {
    let parent = shape.parentId as string | undefined;
    for (let depth = 0; parent && depth < 16; depth += 1) {
      if (pageIds.has(parent)) return parent;
      parent = parentOf.get(parent);
    }
    return null;
  };

  const byPage = new Map<string, { words: string[]; ink: number; images: number }>();
  for (const page of pages) byPage.set(page.id as string, { words: [], ink: 0, images: 0 });
  for (const shape of shapes) {
    const pageId = pageOf(shape);
    if (!pageId) continue;
    const entry = byPage.get(pageId)!;
    const type = String(shape.type);
    if (INK_TYPES.has(type)) entry.ink += 1;
    else if (IMAGE_TYPES.has(type)) entry.images += 1;
    const words = shapeWords(shape.props);
    if (words) entry.words.push(words);
  }

  return pages.map((page, index) => {
    const entry = byPage.get(page.id as string)!;
    const text = entry.words.join(" · ");
    const words = text.length > PAGE_TEXT_MAX_CHARS ? `${text.slice(0, PAGE_TEXT_MAX_CHARS - 1)}…` : text;
    const extras = [
      entry.ink > 0 ? `${entry.ink} drawing${entry.ink === 1 ? "" : "s"}` : "",
      entry.images > 0 ? `${entry.images} image${entry.images === 1 ? "" : "s"}` : "",
    ].filter(Boolean).join(", ");
    const body = [words ? `“${words}”` : "", extras ? `(${extras})` : ""].filter(Boolean).join(" ");
    return `${title}, page ${index + 1}: ${body || "empty"}`;
  });
}

/** Lines from several boards, cut to the budget at a line boundary. */
export function joinBoardOutlines(lines: readonly string[]): string {
  const kept: string[] = [];
  let length = 0;
  for (const line of lines) {
    if (length + line.length + 1 > BOARD_OUTLINE_MAX_CHARS) break;
    kept.push(line);
    length += line.length + 1;
  }
  return kept.join("\n");
}
