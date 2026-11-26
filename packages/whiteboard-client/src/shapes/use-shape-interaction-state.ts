import { useCallback } from "react";
import { useValue, type Editor, type TLShape, type TLShapePartial } from "tldraw";

/**
 * Reactive interaction state and safe prop updater shared by custom editable
 * shapes (code, table, math).
 *
 * These read editor *instance* state rather than the shape record: tldraw's
 * `InnerShape` only re-renders when props/meta change and its tracking scope
 * ends when `component()` returns, so subscribing via `useValue` keeps
 * readonly, selection, and editing state fresh across editor transitions.
 */
export function useShapeInteractionState<TShape extends TLShape>(
  editor: Editor,
  shape: Pick<TShape, "id" | "type">,
) {
  const isReadonly = useValue("shape readonly", () => editor.getIsReadonly(), [editor]);
  const isEditing = useValue(
    "shape editing",
    () => editor.getEditingShapeId() === shape.id,
    [editor, shape.id],
  );
  const isSelected = useValue(
    "shape selected",
    () => editor.getSelectedShapeIds().includes(shape.id),
    [editor, shape.id],
  );

  const updateProps = useCallback(
    (props: Partial<TShape["props"]>) => {
      if (isReadonly || !editor.getShape(shape.id)) return;
      editor.updateShape<TShape>({
        id: shape.id,
        type: shape.type,
        props,
      } as TLShapePartial<TShape>);
    },
    [editor, isReadonly, shape.id, shape.type],
  );

  return { isReadonly, isEditing, isSelected, updateProps };
}
