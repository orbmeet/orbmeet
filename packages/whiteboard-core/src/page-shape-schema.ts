import { clampFinite } from "@orbmeet/primitives";
import {
  createShapePropsMigrationIds,
  createShapePropsMigrationSequence,
  type TLShape,
} from "@tldraw/tlschema";
import { T } from "@tldraw/validate";
import {
  pageBackgroundValidator,
  parsePageBackground,
  type PageBackground,
} from "./page-background.ts";
import { WHITEBOARD_CONFIG } from "./config.ts";

export const WHITEBOARD_PAGE_SHAPE_TYPE = "whiteboard-page" as const;
export const MAX_WHITEBOARD_PAGE_FRAME_DIMENSION = 100_000;
export const MAX_WHITEBOARD_PAGE_FRAME_NAME_LENGTH = 255;

export interface WhiteboardPageShapeProps {
  w: number;
  h: number;
  name: string;
  background: PageBackground;
}

declare module "@tldraw/tlschema" {
  export interface TLGlobalShapePropsMap {
    [WHITEBOARD_PAGE_SHAPE_TYPE]: WhiteboardPageShapeProps;
  }
}

export type WhiteboardPageShape = TLShape<typeof WHITEBOARD_PAGE_SHAPE_TYPE>;

const boundedPageFrameDimension = (label: string) =>
  T.number.check(label, (value) => {
    if (
      !Number.isFinite(value) ||
      value <= 0 ||
      value > MAX_WHITEBOARD_PAGE_FRAME_DIMENSION
    ) {
      throw new Error(
        `Expected ${label} to be in range 1..${MAX_WHITEBOARD_PAGE_FRAME_DIMENSION}`,
      );
    }
  });

const boundedPageFrameName = T.string.check("whiteboard page name", (value) => {
  if (value.length > MAX_WHITEBOARD_PAGE_FRAME_NAME_LENGTH) {
    throw new Error(
      `Expected whiteboard page name to be at most ${MAX_WHITEBOARD_PAGE_FRAME_NAME_LENGTH} characters`,
    );
  }
});

export const WHITEBOARD_PAGE_SHAPE_PROPS = {
  w: boundedPageFrameDimension("whiteboard page width"),
  h: boundedPageFrameDimension("whiteboard page height"),
  name: boundedPageFrameName,
  background: pageBackgroundValidator,
};

const whiteboardPageShapeVersions = createShapePropsMigrationIds(
  WHITEBOARD_PAGE_SHAPE_TYPE,
  {
    AddBackground: 1,
    NormalizeBounds: 2,
  },
);

function normalizePageFrameName(value: unknown): string {
  const name = typeof value === "string" && value.length > 0
    ? value
    : "Page";
  return name.slice(0, MAX_WHITEBOARD_PAGE_FRAME_NAME_LENGTH);
}

export const WHITEBOARD_PAGE_SHAPE_MIGRATIONS = createShapePropsMigrationSequence({
  sequence: [
    {
      id: whiteboardPageShapeVersions.AddBackground,
      up(props) {
        props.background = parsePageBackground(props.background);
      },
      down(props) {
        // The schema before this version has no background prop, and its
        // validator rejects properties it does not know.
        delete props.background;
      },
    },
    {
      id: whiteboardPageShapeVersions.NormalizeBounds,
      up(props) {
        props.w = clampFinite(props.w, 1, MAX_WHITEBOARD_PAGE_FRAME_DIMENSION, WHITEBOARD_CONFIG.PAGE_WIDTH);
        props.h = clampFinite(props.h, 1, MAX_WHITEBOARD_PAGE_FRAME_DIMENSION, WHITEBOARD_CONFIG.PAGE_HEIGHT);
        props.name = normalizePageFrameName(props.name);
      },
      down(props) {
        props.w = clampFinite(props.w, 1, MAX_WHITEBOARD_PAGE_FRAME_DIMENSION, WHITEBOARD_CONFIG.PAGE_WIDTH);
        props.h = clampFinite(props.h, 1, MAX_WHITEBOARD_PAGE_FRAME_DIMENSION, WHITEBOARD_CONFIG.PAGE_HEIGHT);
        props.name = normalizePageFrameName(props.name);
      },
    },
  ],
});
