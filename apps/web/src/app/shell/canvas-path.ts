/**
 * The whiteboard editor: a full-bleed canvas the shell keeps clear of its own
 * chrome — no install offer, and no phone header or dock competing with the
 * board for room.
 */
export function isCanvasPath(pathname: string): boolean {
  return /^\/whiteboards\/[^/]+\/?$/.test(pathname);
}
