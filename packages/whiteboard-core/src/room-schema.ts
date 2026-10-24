import { createTLSchema, defaultShapeSchemas, defaultBindingSchemas } from "@tldraw/tlschema";

import {
  TABLE_SHAPE_MIGRATIONS,
  TABLE_SHAPE_PROPS,
  TABLE_SHAPE_TYPE,
} from "./table-shape-schema.ts";
import {
  WHITEBOARD_PAGE_SHAPE_MIGRATIONS,
  WHITEBOARD_PAGE_SHAPE_PROPS,
  WHITEBOARD_PAGE_SHAPE_TYPE,
} from "./page-shape-schema.ts";
import {
  MATH_SHAPE_MIGRATIONS,
  MATH_SHAPE_PROPS,
  MATH_SHAPE_TYPE,
} from "./math-shape-schema.ts";
import {
  CODE_SHAPE_MIGRATIONS,
  CODE_SHAPE_PROPS,
  CODE_SHAPE_TYPE,
} from "./code-shape-schema.ts";
import { boundedRichTextValidator } from "./math/math-rich-text-schema.ts";
import { ROOM_NAVIGATION_RECORD_INFO, ROOM_NAVIGATION_TYPE } from "./room-navigation.ts";

/**
 * The rich-text props of tldraw's text-bearing shapes, with the room's bounded
 * validator in place of tldraw's. The room validates against these, and the
 * client's shape utils declare the same ones (`whiteboard-shapes.ts`): a
 * client that accepted rich text the room rejects would have its push refused
 * as INVALID_RECORD, which ends its session.
 */
export const BOUNDED_RICH_TEXT_SHAPE_PROPS = {
  arrow: { ...defaultShapeSchemas.arrow.props, richText: boundedRichTextValidator },
  geo: { ...defaultShapeSchemas.geo.props, richText: boundedRichTextValidator },
  note: { ...defaultShapeSchemas.note.props, richText: boundedRichTextValidator },
  text: { ...defaultShapeSchemas.text.props, richText: boundedRichTextValidator },
};

const defaultShapesWithBoundedMath = {
  ...defaultShapeSchemas,
  arrow: { ...defaultShapeSchemas.arrow, props: BOUNDED_RICH_TEXT_SHAPE_PROPS.arrow },
  geo: { ...defaultShapeSchemas.geo, props: BOUNDED_RICH_TEXT_SHAPE_PROPS.geo },
  note: { ...defaultShapeSchemas.note, props: BOUNDED_RICH_TEXT_SHAPE_PROPS.note },
  text: { ...defaultShapeSchemas.text, props: BOUNDED_RICH_TEXT_SHAPE_PROPS.text },
};

/** Every shape type the room knows, with the props it validates them by. */
export const WHITEBOARD_SHAPE_SCHEMAS = {
    ...defaultShapesWithBoundedMath,
    [WHITEBOARD_PAGE_SHAPE_TYPE]: {
      props: WHITEBOARD_PAGE_SHAPE_PROPS,
      migrations: WHITEBOARD_PAGE_SHAPE_MIGRATIONS,
    },
    [TABLE_SHAPE_TYPE]: {
      props: TABLE_SHAPE_PROPS,
      migrations: TABLE_SHAPE_MIGRATIONS,
    },
    [MATH_SHAPE_TYPE]: {
      props: MATH_SHAPE_PROPS,
      migrations: MATH_SHAPE_MIGRATIONS,
    },
    [CODE_SHAPE_TYPE]: {
      props: CODE_SHAPE_PROPS,
      migrations: CODE_SHAPE_MIGRATIONS,
    },
};

/** The room's own record types, beside tldraw's. The client's store declares the same. */
export const WHITEBOARD_RECORD_SCHEMAS = {
  [ROOM_NAVIGATION_TYPE]: ROOM_NAVIGATION_RECORD_INFO,
};

export const whiteboardTLSchema = createTLSchema({
  shapes: WHITEBOARD_SHAPE_SCHEMAS,
  // Arrow shapes use the `arrow` binding type; include default binding schemas
  // so the server validates binding records (matches the documented server-schema
  // pattern in docs/tldraw/docs/sync.mdx §Custom shapes & bindings).
  bindings: defaultBindingSchemas,
  records: WHITEBOARD_RECORD_SCHEMAS,
});
