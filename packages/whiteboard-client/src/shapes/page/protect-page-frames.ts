import type { Editor } from "tldraw";
import { isPageFrameShape, type PageFrameShape } from "@orbmeet/whiteboard-core/page-frame-model";

const pageFrameMutationAllowanceDepth = new WeakMap<Editor, number>();

/**
 * Temporarily allow controlled page-frame mutations/deletions from internal
 * whiteboard logic (e.g. insert / renumber / PDF import cleanup) while keeping
 * direct user edits blocked.
 */
export function withPageFrameMutationAllowance<T>(editor: Editor, fn: () => T): T {
  const currentDepth = pageFrameMutationAllowanceDepth.get(editor) ?? 0;
  pageFrameMutationAllowanceDepth.set(editor, currentDepth + 1);
  try {
    return fn();
  } finally {
    const nextDepth = (pageFrameMutationAllowanceDepth.get(editor) ?? 1) - 1;
    if (nextDepth <= 0) {
      pageFrameMutationAllowanceDepth.delete(editor);
    } else {
      pageFrameMutationAllowanceDepth.set(editor, nextDepth);
    }
  }
}

function hasPageFrameMutationAllowance(editor: Editor): boolean {
  return (pageFrameMutationAllowanceDepth.get(editor) ?? 0) > 0;
}

/**
 * Registers side effects to protect page frames from being deleted, moved,
 * or resized by users. Replaces isLocked which also blocked the eraser on children.
 *
 * Deletes are blocked unless trusted internal page operations opt in to a
 * temporary allowance. Geometry/name mutations are blocked for local user
 * operations; remote sync is accepted so collaborators can receive legitimate
 * page-manager updates from the editing client.
 */
export function registerPageFrameProtection(editor: Editor): () => void {
  const unregisterDelete = editor.sideEffects.registerBeforeDeleteHandler(
    "shape",
    (shape, source) => {
      // Block page frame deletion unless explicitly allowed by trusted logic.
      if (
        source !== "remote" &&
        isPageFrameShape(shape) &&
        !hasPageFrameMutationAllowance(editor)
      ) {
        return false;
      }
      return;
    }
  );

  const unregisterChange = editor.sideEffects.registerBeforeChangeHandler(
    "shape",
    (prev, next, source) => {
      // Only lock geometry/name for direct user-initiated changes.
      // Internal page operations can opt in via withPageFrameMutationAllowance().
      if (source !== "user" || hasPageFrameMutationAllowance(editor)) return next;
      if (!isPageFrameShape(next)) return next;
      // The lock restores geometry from the previous revision, so it only means
      // anything when that revision was a page frame too. A user-initiated
      // change that *turns* a shape into one is not something the product does;
      // reject it rather than write undefined dimensions into the shape.
      if (!isPageFrameShape(prev)) return prev;

      const prevFrame = prev as PageFrameShape;

      return {
        ...next,
        x: prevFrame.x,
        y: prevFrame.y,
        rotation: prevFrame.rotation,
        props: {
          ...(next as PageFrameShape).props,
          w: prevFrame.props.w,
          h: prevFrame.props.h,
          name: prevFrame.props.name,
        },
      };
    }
  );

  return () => {
    unregisterDelete();
    unregisterChange();
  };
}
