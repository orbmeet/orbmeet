import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DESKTOP_TOP_BAR_HEIGHT_PX,
  DESKTOP_TOP_BAR_TWO_ROW_HEIGHT_PX,
  DESKTOP_TOP_BAR_TWO_ROW_MAX_WIDTH_PX,
} from "@/modules/meetings/client/chrome";

describe("MeetingTopBar", () => {
  it("paints exactly the band the stage reserves for it", () => {
    // StyleX needs a literal, so the bar's height cannot import the constant.
    // If the two drift, content slides under the bar or a strip opens above it.
    const source = readFileSync(new URL("./meeting-top-bar.tsx", import.meta.url), "utf8");
    expect(source).toContain(`height: { default: ${DESKTOP_TOP_BAR_HEIGHT_PX}, [TWO_ROWS]: ${DESKTOP_TOP_BAR_TWO_ROW_HEIGHT_PX} }`);
    expect(source).toContain(`"@media (max-width: ${DESKTOP_TOP_BAR_TWO_ROW_MAX_WIDTH_PX}px)"`);
  });

  it("reserves the two-row height on the stage below the same width", () => {
    // A stage reserving only the one-row height let the bar cover the
    // board's page and zoom bar on a portrait tablet.
    const shell = readFileSync(new URL("./meeting-shell.tsx", import.meta.url), "utf8");
    expect(shell).toContain(`"@media (max-width: ${DESKTOP_TOP_BAR_TWO_ROW_MAX_WIDTH_PX}px)": "${DESKTOP_TOP_BAR_TWO_ROW_HEIGHT_PX}px"`);
    expect(shell).toContain(`default: "${DESKTOP_TOP_BAR_HEIGHT_PX}px"`);
  });
});
