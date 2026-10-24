import { describe, expect, it } from "vitest";
import { Group2d, type Editor, type SvgExportContext } from "tldraw";
import { createShapeId, type TLParentId } from "@tldraw/tlschema";
import type { ReactElement } from "react";
import type { PageBackground } from "@orbmeet/whiteboard-core/page-background";
import { WhiteboardPageShapeUtil } from "./page-shape-util";
import {
  WHITEBOARD_PAGE_SHAPE_TYPE,
  type WhiteboardPageShape,
} from "@orbmeet/whiteboard-core/page-shape-schema";

function pageShape(background: PageBackground = "white"): WhiteboardPageShape {
  return {
    id: createShapeId("page-1"),
    typeName: "shape",
    type: WHITEBOARD_PAGE_SHAPE_TYPE,
    parentId: "page:page" as TLParentId,
    index: "a1" as never,
    x: 0,
    y: 0,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    props: {
      w: 1200,
      h: 900,
      name: "Page 1",
      background,
    },
    meta: {},
  };
}

function svgExportContext(defs: { key: string }[]): SvgExportContext {
  return {
    addExportDef: (def) => {
      defs.push({ key: def.key });
    },
    waitUntil: () => {},
    resolveAssetUrl: async () => null,
    isDarkMode: false,
    colorMode: "light",
    scale: 1,
    pixelRatio: null,
  };
}

describe("WhiteboardPageShapeUtil", () => {
  it("uses grouped geometry for tldraw frame-like hit testing", () => {
    const util = new WhiteboardPageShapeUtil({} as Editor);
    const geometry = util.getGeometry(pageShape());

    expect(geometry).toBeInstanceOf(Group2d);
    expect((geometry).children).toHaveLength(1);
  });

  it("exports patterned backgrounds as a background layer with a shared SVG def", () => {
    const util = new WhiteboardPageShapeUtil({} as Editor);
    const defs: { key: string }[] = [];
    const svg = util.toBackgroundSvg(pageShape("white-grid"), svgExportContext(defs)) as ReactElement<{
      children: unknown;
    }>;

    expect(svg.type).toBe("g");
    expect(defs).toEqual([
      expect.objectContaining({ key: expect.stringContaining("wb-page-bg-") }),
    ]);
    const [, patternFill] = svg.props.children as ReactElement<{
      fill: string;
    }>[];
    expect(patternFill.props.fill).toContain("url(#wb-page-bg-");
  });

  it("keeps solid backgrounds as a simple export rect", () => {
    const util = new WhiteboardPageShapeUtil({} as Editor);
    const defs: { key: string }[] = [];
    const svg = util.toBackgroundSvg(pageShape("dark"), svgExportContext(defs)) as ReactElement<{
      fill: string;
    }>;

    expect(svg.type).toBe("rect");
    expect(svg.props.fill).toBe("#111111");
    expect(defs).toEqual([]);
  });
});
