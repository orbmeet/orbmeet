import type { Editor } from "tldraw";
import { hasShapeAuthor, withShapeAuthor, type ShapeAuthor } from "@orbmeet/whiteboard-core/shape-author";

/**
 * Stamp this user as the author of every shape they create, so Show sources
 * can name them at once instead of after a round trip.
 *
 * Only the user's own creations are stamped: shapes arriving from the room
 * already carry the author the room settled on. A paste, a duplicate or an
 * undo that brings a shape back is a creation too, so the copy belongs to
 * whoever made it, which is the same rule the room enforces.
 */
export function registerShapeAuthorStamp(editor: Editor, author: ShapeAuthor): () => void {
  return editor.sideEffects.registerBeforeCreateHandler("shape", (shape, source) => {
    if (source !== "user" || hasShapeAuthor(shape.meta, author)) return shape;
    return { ...shape, meta: withShapeAuthor(shape.meta, author) };
  });
}
