import { createElement, type CSSProperties, type ReactElement } from "react";
import type { PageBackground } from "@orbmeet/whiteboard-core/page-background";

interface PageBackgroundRenderSpec {
  base: string;
  pattern: "plain" | "dots" | "lines" | "grid";
  dotColor?: string;
  lineColor?: string;
  dotSpacing: number;
  lineSpacing: number;
  gridSpacing: number;
  dotRadius: number;
  lineWidth: number;
}

const PAGE_BACKGROUND_SPECS = {
  white: { base: "#ffffff", pattern: "plain" },
  "white-dots": { base: "#ffffff", pattern: "dots", dotColor: "rgba(0,0,0,0.18)" },
  "white-lines": { base: "#fafaf9", pattern: "lines", lineColor: "rgba(0,0,0,0.1)" },
  "white-grid": { base: "#ffffff", pattern: "grid", lineColor: "rgba(0,0,0,0.1)" },
  dark: { base: "#111111", pattern: "plain" },
  "dark-dots": { base: "#111111", pattern: "dots", dotColor: "rgba(255,255,255,0.14)" },
  "dark-lines": { base: "#111111", pattern: "lines", lineColor: "rgba(255,255,255,0.08)" },
  "dark-grid": { base: "#111111", pattern: "grid", lineColor: "rgba(255,255,255,0.08)" },
} satisfies Record<PageBackground, Partial<PageBackgroundRenderSpec> & Pick<PageBackgroundRenderSpec, "base" | "pattern">>;

function getRenderSpec(background: PageBackground): PageBackgroundRenderSpec {
  return { dotSpacing: 60, lineSpacing: 40, gridSpacing: 60, dotRadius: 1.5, lineWidth: 1, ...PAGE_BACKGROUND_SPECS[background] };
}

export function getBackgroundStyle(background: PageBackground, scale = 1): CSSProperties {
  const spec = getRenderSpec(background);
  const gridSize = Math.round(spec.gridSpacing * scale);
  const dotSize = Math.round(spec.dotSpacing * scale);
  const lineSpacing = Math.round(spec.lineSpacing * scale);
  switch (spec.pattern) {
    case "plain": return { background: spec.base };
    case "dots": return { background: spec.base, backgroundImage: `radial-gradient(circle, ${spec.dotColor} ${spec.dotRadius}px, transparent ${spec.dotRadius}px)`, backgroundSize: `${dotSize}px ${dotSize}px` };
    case "lines": return { background: spec.base, backgroundImage: `linear-gradient(to bottom, transparent calc(${lineSpacing}px - ${spec.lineWidth}px), ${spec.lineColor} ${spec.lineWidth}px)`, backgroundSize: `100% ${lineSpacing}px` };
    case "grid": return { background: spec.base, backgroundImage: [`linear-gradient(to right, ${spec.lineColor} ${spec.lineWidth}px, transparent ${spec.lineWidth}px)`, `linear-gradient(to bottom, ${spec.lineColor} ${spec.lineWidth}px, transparent ${spec.lineWidth}px)`].join(", "), backgroundSize: `${gridSize}px ${gridSize}px` };
  }
}

export function getPageBackgroundSvgPatternId(shapeId: string, background: PageBackground): string {
  return `wb-page-bg-${shapeId.replace(/[^a-zA-Z0-9_-]/g, "-")}-${background}`;
}

export function getPageBackgroundSvgDef(background: PageBackground, patternId: string): ReactElement | null {
  const spec = getRenderSpec(background);
  if (spec.pattern === "plain") return null;
  if (spec.pattern === "dots") {
    return createElement("pattern", { id: patternId, width: spec.dotSpacing, height: spec.dotSpacing, patternUnits: "userSpaceOnUse" }, createElement("circle", { cx: spec.dotSpacing / 2, cy: spec.dotSpacing / 2, r: spec.dotRadius, fill: spec.dotColor }));
  }
  const spacing = spec.pattern === "lines" ? spec.lineSpacing : spec.gridSpacing;
  const path = spec.pattern === "lines" ? `M 0 ${spec.lineSpacing - spec.lineWidth / 2} H ${spec.lineSpacing}` : `M ${spec.lineWidth / 2} 0 V ${spec.gridSpacing} M 0 ${spec.lineWidth / 2} H ${spec.gridSpacing}`;
  return createElement("pattern", { id: patternId, width: spacing, height: spacing, patternUnits: "userSpaceOnUse" }, createElement("path", { d: path, stroke: spec.lineColor, strokeWidth: spec.lineWidth }));
}

export function getPageBackgroundSvgElement(options: { bg: PageBackground; width: number; height: number; patternId?: string }): ReactElement {
  const spec = getRenderSpec(options.bg);
  const baseRect = createElement("rect", { key: "base", width: options.width, height: options.height, fill: spec.base, stroke: "none", rx: 0, ry: 0 });
  if (spec.pattern === "plain" || !options.patternId) return baseRect;
  return createElement("g", null, baseRect, createElement("rect", { key: "pattern", width: options.width, height: options.height, fill: `url(#${options.patternId})`, stroke: "none", rx: 0, ry: 0 }));
}
