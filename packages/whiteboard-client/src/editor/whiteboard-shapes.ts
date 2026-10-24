import {
  ArrowShapeUtil,
  defaultShapeUtils,
  GeoShapeUtil,
  NoteShapeUtil,
  TextShapeUtil,
} from "tldraw";
import { BOUNDED_RICH_TEXT_SHAPE_PROPS } from "@orbmeet/whiteboard-core/room-schema";
import { WhiteboardPageShapeUtil } from "../shapes/page/page-shape-util";
import { TableShapeUtil } from "../shapes/table/table-shape-util";
import { MathShapeUtil } from "../shapes/math/math-shape-util";
import { CodeShapeUtil } from "../shapes/code/code-shape-util";

// tldraw's text-bearing shapes, validating rich text exactly as the room does.
// With tldraw's own validators the editor would accept text the room refuses,
// and the room answers that push by ending the session.
class BoundedArrowShapeUtil extends ArrowShapeUtil {
  static override props = BOUNDED_RICH_TEXT_SHAPE_PROPS.arrow;
}
class BoundedGeoShapeUtil extends GeoShapeUtil {
  static override props = BOUNDED_RICH_TEXT_SHAPE_PROPS.geo;
}
class BoundedNoteShapeUtil extends NoteShapeUtil {
  static override props = BOUNDED_RICH_TEXT_SHAPE_PROPS.note;
}
class BoundedTextShapeUtil extends TextShapeUtil {
  static override props = BOUNDED_RICH_TEXT_SHAPE_PROPS.text;
}

/** Ours, and the defaults they replace; tldraw adds the rest of its defaults by type. */
export const whiteboardShapeUtils = [
  WhiteboardPageShapeUtil,
  TableShapeUtil,
  MathShapeUtil,
  CodeShapeUtil,
  BoundedArrowShapeUtil,
  BoundedGeoShapeUtil,
  BoundedNoteShapeUtil,
  BoundedTextShapeUtil,
];

const replacedTypes = new Set<string>(whiteboardShapeUtils.map((util) => util.type));

/** The complete set, for `useSync`, which does not add tldraw's defaults itself. */
export const whiteboardSyncShapeUtils = [
  ...whiteboardShapeUtils,
  ...defaultShapeUtils.filter((util) => !replacedTypes.has(util.type)),
];
