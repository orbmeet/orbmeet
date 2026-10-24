import {
  BaseBoxShapeTool,
  type TLShape,
  type TLStateNodeConstructor,
} from "tldraw";
import { TABLE_SHAPE_TYPE } from "@orbmeet/whiteboard-core/table-shape-schema";

export const TableTool: TLStateNodeConstructor = class TableTool extends BaseBoxShapeTool {
  static override id = "table";
  static override isLockable = false;

  override shapeType = TABLE_SHAPE_TYPE;
  private unregisterCreateHandler?: () => void;

  override onEnter() {
    this.unregisterCreateHandler = this.editor.sideEffects.registerAfterCreateHandler(
      "shape",
      (shape, source) => {
        if (source !== "user" || shape.type !== TABLE_SHAPE_TYPE) return;
        if (this.editor.inputs.getIsDragging()) return;

        queueMicrotask(() => {
          if (this.editor.getShape(shape.id)) {
            this.editor.setEditingShape(shape.id);
          }
        });
      }
    );
  }

  override onExit() {
    this.unregisterCreateHandler?.();
    this.unregisterCreateHandler = undefined;
  }

  override onCreate(shape: TLShape | null) {
    if (!shape) return;
    this.editor.setEditingShape(shape.id);
  }
};
