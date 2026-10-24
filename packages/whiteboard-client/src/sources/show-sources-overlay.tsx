import { Fragment, useEffect, useState } from "react";
import { useEditor, useValue, type TLParentId, type TLShapeId } from "tldraw";
import { FileText, PenLine, Shapes, Type, type LucideIcon } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import { accent, neutral, violet } from "@orbmeet/ui/tokens/colors.stylex";
import { boardZIndex } from "@orbmeet/ui/tokens/layers.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import { describeShapeSource, type ShapeSource, type ShapeSourceKind } from "./shape-source";
import { isShowingSources } from "./show-sources-state";
import { useWhiteboardToolbarContext } from "../toolbar/whiteboard-toolbar-context";

const NO_LIBRARY_NAMES: ReadonlyMap<string, string> = new Map();

/** Past this many on screen, labels stop helping; the rest stay unlabelled. */
const MAX_LABELLED_SHAPES = 200;
/** Room between a shape and its outline, in screen pixels. */
const OUTLINE_GAP = 4;
/** A label's height, so one above a shape near the top edge can stay on screen. */
const CHIP_HEIGHT = 22;

const ICONS: Record<ShapeSourceKind, LucideIcon> = {
  typed: Type,
  drawn: PenLine,
  imported: FileText,
  placed: Shapes,
};

const styles = stylex.create({
  layer: {
    position: "absolute",
    inset: 0,
    overflow: "hidden",
    pointerEvents: "none",
    zIndex: boardZIndex.sources,
  },
  outline: (left: number, top: number, width: number, height: number) => ({
    position: "absolute",
    left,
    top,
    width,
    height,
    borderWidth: 1.5,
    borderStyle: "solid",
    borderRadius: 4,
  }),
  typed: { borderColor: violet.v500 },
  drawn: { borderColor: accent.a500 },
  imported: { borderColor: neutral.n500, borderStyle: "dashed" },
  placed: { borderColor: neutral.n400 },
  chipAt: (left: number, top: number) => ({ left, top }),
  /** Hangs above the point it is placed at, so the label sits on the outline. */
  chipAbove: { transform: "translateY(-100%)" },
  chip: {
    position: "absolute",
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    maxWidth: 260,
    height: CHIP_HEIGHT,
    paddingInline: space.s2,
    borderRadius: radii.pill,
    backgroundColor: neutral.n50,
    boxShadow: shadows.chip,
    color: neutral.n800,
    fontFamily: fonts.sans,
    fontSize: text.xs,
    fontWeight: weight.medium,
    whiteSpace: "nowrap",
  },
  label: { overflow: "hidden", textOverflow: "ellipsis" },
  author: { color: neutral.n500, flexShrink: 0 },
  icon: { flexShrink: 0, color: neutral.n500 },
});

interface LabelledShape {
  id: TLShapeId;
  source: ShapeSource;
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Show sources: an outline and a label on everything in view, saying what it
 * is and who added it, so a note typed onto a slide can be told from the slide.
 * Labels follow the camera; they never take a pointer.
 */
export function ShowSourcesOverlay() {
  const editor = useEditor();
  const { pdfLibrary } = useWhiteboardToolbarContext();
  const showing = useValue("showing sources", () => isShowingSources(editor), [editor]);

  // A PDF page filed from the Space is labelled with the file's name, which
  // only the Space's library knows. Read it each time labels are turned on so
  // a newly filed PDF is named; anyone who can't read the library (a visitor
  // from outside the Space) gets the page number alone.
  const [libraryNames, setLibraryNames] = useState(NO_LIBRARY_NAMES);
  useEffect(() => {
    if (!showing || !pdfLibrary) return;
    let current = true;
    pdfLibrary.list().then(
      (files) => {
        if (current) setLibraryNames(new Map(files.map((file) => [file.id, file.filename])));
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [showing, pdfLibrary]);

  const shapes = useValue(
    "labelled shapes",
    (): LabelledShape[] => {
      if (!isShowingSources(editor)) return [];
      const culled = editor.getCulledShapes();
      const board = {
        getAsset: editor.getAsset.bind(editor),
        getParent: (id: TLParentId) => editor.getShape(id),
        getLibraryFileName: (fileId: string) => libraryNames.get(fileId),
      };
      const labelled: LabelledShape[] = [];
      for (const shape of editor.getCurrentPageShapesSorted()) {
        if (culled.has(shape.id)) continue;
        const source = describeShapeSource(shape, board);
        const bounds = source && editor.getShapePageBounds(shape);
        if (!source || !bounds) continue;
        const topLeft = editor.pageToViewport({ x: bounds.minX, y: bounds.minY });
        const bottomRight = editor.pageToViewport({ x: bounds.maxX, y: bounds.maxY });
        labelled.push({
          id: shape.id,
          source,
          left: topLeft.x,
          top: topLeft.y,
          width: bottomRight.x - topLeft.x,
          height: bottomRight.y - topLeft.y,
        });
        if (labelled.length === MAX_LABELLED_SHAPES) break;
      }
      return labelled;
    },
    [editor, libraryNames],
  );

  if (shapes.length === 0) return null;
  return (
    <div aria-hidden {...stylex.props(styles.layer)}>
      {shapes.map(({ id, source, left, top, width, height }) => {
        const Icon = ICONS[source.kind];
        const x = left - OUTLINE_GAP;
        const y = top - OUTLINE_GAP;
        // An imported page fills its frame and the frame's name sits above it,
        // so its label goes inside the top-left corner; everything else is
        // labelled just above, kept on screen near the top edge.
        const inside = source.kind === "imported";
        const chipTop = inside
          ? Math.max(OUTLINE_GAP, top + OUTLINE_GAP)
          : Math.max(CHIP_HEIGHT + OUTLINE_GAP, y - OUTLINE_GAP);
        return (
          <Fragment key={id}>
            <div
              {...stylex.props(
                styles.outline(x, y, width + OUTLINE_GAP * 2, height + OUTLINE_GAP * 2),
                styles[source.kind],
              )}
            />
            <div
              {...stylex.props(
                styles.chip,
                styles.chipAt(inside ? left + OUTLINE_GAP : x, chipTop),
                !inside && styles.chipAbove,
              )}
            >
              <Icon size={12} strokeWidth={2} {...stylex.props(styles.icon)} />
              <span {...stylex.props(styles.label)}>{source.label}</span>
              {source.author && <span {...stylex.props(styles.author)}>· {source.author.name}</span>}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
