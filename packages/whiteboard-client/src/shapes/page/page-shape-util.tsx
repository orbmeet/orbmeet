import {
  BaseFrameLikeShapeUtil,
  Group2d,
  HTMLContainer,
  Rectangle2d,
  type RecordProps,
  type SvgExportContext,
} from "tldraw";
import {
  DEFAULT_PAGE_BACKGROUND,
  parsePageBackground,
} from "@orbmeet/whiteboard-core/page-background";
import { WHITEBOARD_CONFIG } from "@orbmeet/whiteboard-core/config";
import {
  getBackgroundStyle,
  getPageBackgroundSvgDef,
  getPageBackgroundSvgElement,
  getPageBackgroundSvgPatternId,
} from "./page-background-rendering";
import {
  WHITEBOARD_PAGE_SHAPE_MIGRATIONS,
  WHITEBOARD_PAGE_SHAPE_PROPS,
  WHITEBOARD_PAGE_SHAPE_TYPE,
  type WhiteboardPageShape,
} from "@orbmeet/whiteboard-core/page-shape-schema";
import * as stylex from "@stylexjs/stylex";
import { withBoardClass } from "../../styles/board";
import { inkWash } from "@orbmeet/ui/tokens/wash.stylex";

const styles = stylex.create({
  /**
   * The page carries no caption. In one continuous stack a name above each
   * page sat in the gap between two pages, or under the board's top band on
   * page 1, and the page control and the page list already number pages.
   */
  frame: {
    // Nothing extends past the frame: the background is the container's own.
    overflow: "visible",
    pointerEvents: "none",
    // Spread-only ring first: box-shadow geometry is page space, so a blurred
    // shadow shrinks to nothing at a phone's fit-width zoom (~0.3). The ring
    // survives that and is what defines the page; it is a whisper (x06, not
    // x12) because it only has to hold the edge, not draw a border.
    // The page is a flat sheet on the desk, not paper lifted off it: one
    // tight contact shadow for depth, and none of the 40px drop that made it
    // read as a physical object hovering over the board.
    boxShadow: `0 0 0 2px ${inkWash.x06}, 0 1px 3px ${inkWash.x06}`,
  },
});

export class WhiteboardPageShapeUtil extends BaseFrameLikeShapeUtil<WhiteboardPageShape> {
  static override type = WHITEBOARD_PAGE_SHAPE_TYPE;
  static override props: RecordProps<WhiteboardPageShape> = WHITEBOARD_PAGE_SHAPE_PROPS;
  static override migrations = WHITEBOARD_PAGE_SHAPE_MIGRATIONS;

  override getDefaultProps(): WhiteboardPageShape["props"] {
    return {
      // The canonical page size, read from config rather than copied: a
      // default that drifts from it produces frames the camera fits wrong.
      w: WHITEBOARD_CONFIG.PAGE_WIDTH,
      h: WHITEBOARD_CONFIG.PAGE_HEIGHT,
      name: "Page",
      background: DEFAULT_PAGE_BACKGROUND,
    };
  }

  override canEdit() {
    return false;
  }

  override canResize() {
    return false;
  }

  override isExportBoundsContainer(): boolean {
    return true;
  }

  override getAriaDescriptor(shape: WhiteboardPageShape) {
    return shape.props.name;
  }

  override getText(shape: WhiteboardPageShape): string | undefined {
    return shape.props.name;
  }

  override getGeometry(shape: WhiteboardPageShape) {
    return new Group2d({
      children: [
        new Rectangle2d({
          width: shape.props.w,
          height: shape.props.h,
          isFilled: false,
        }),
      ],
    });
  }

  override component(shape: WhiteboardPageShape) {
    return (
      <HTMLContainer
        {...withBoardClass("tl-frame__body", styles.frame)}
        style={{
          width: shape.props.w,
          height: shape.props.h,
          ...getBackgroundStyle(parsePageBackground(shape.props.background)),
        }}
      />
    );
  }

  override toBackgroundSvg(shape: WhiteboardPageShape, ctx: SvgExportContext) {
    const bg = parsePageBackground(shape.props.background);
    const patternId = getPageBackgroundSvgPatternId(shape.id, bg);
    const patternDef = getPageBackgroundSvgDef(bg, patternId);
    if (patternDef) {
      ctx.addExportDef({
        key: patternId,
        getElement: () => patternDef,
      });
    }

    return getPageBackgroundSvgElement({
      bg,
      width: shape.props.w,
      height: shape.props.h,
      patternId,
    });
  }

  override getIndicatorPath(shape: WhiteboardPageShape): Path2D {
    const path = new Path2D();
    path.rect(0, 0, shape.props.w, shape.props.h);
    return path;
  }
}
