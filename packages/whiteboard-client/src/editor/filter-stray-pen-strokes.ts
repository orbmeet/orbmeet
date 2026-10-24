import type { Editor, TLDrawShape, TLHighlightShape } from "tldraw";
import { b64Vecs, Vec } from "tldraw";

type DrawableShape = TLDrawShape | TLHighlightShape;

const MIN_POINTS_FOR_INTENTIONAL_STROKE = 6;
const MAX_DISTANCE_PER_POINT_RATIO = 150;

function isStrayPenStroke(shape: DrawableShape): boolean {
  if (!shape.props.isPen) return false;

  const { segments } = shape.props;
  if (segments.length !== 1) return false;

  const segment = segments[0];
  if (segment.type !== "free") return false;

  const points = b64Vecs.decodePoints(segment.path);
  if (points.length >= MIN_POINTS_FOR_INTENTIONAL_STROKE) return false;
  if (points.length < 2) return false;

  const first = points[0];
  const last = points[points.length - 1];
  const distance = Vec.Dist(first, last);

  return distance / points.length > MAX_DISTANCE_PER_POINT_RATIO;
}

export function registerStrayPenStrokeFilter(editor: Editor): () => void {
  const pendingFrames = new Set<number>();
  let disposed = false;

  const unregister = editor.sideEffects.registerAfterChangeHandler(
    "shape",
    (_prev, next, source) => {
      if (source !== "user") return;
      if (next.type !== "draw" && next.type !== "highlight") return;

      const shape = next as DrawableShape;
      if (!shape.props.isComplete) return;

      if (isStrayPenStroke(shape)) {
        const shapeId = shape.id;
        const frameId = requestAnimationFrame(() => {
          pendingFrames.delete(frameId);
          if (disposed) return;
          const current = editor.getShape(shapeId) as DrawableShape | undefined;
          if (!current) return;
          if (!current.props.isComplete) return;
          if (!isStrayPenStroke(current)) return;
          editor.deleteShape(shapeId);
        });
        pendingFrames.add(frameId);
      }
    }
  );

  return () => {
    disposed = true;
    unregister();
    for (const frameId of pendingFrames) {
      cancelAnimationFrame(frameId);
    }
    pendingFrames.clear();
  };
}
