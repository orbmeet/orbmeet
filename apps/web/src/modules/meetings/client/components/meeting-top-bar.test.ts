import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DESKTOP_TOP_BAR_HEIGHT_PX } from "@/modules/meetings/client/chrome";

describe("MeetingTopBar", () => {
  it("paints exactly the band the stage reserves for it", () => {
    // StyleX needs a literal, so the bar's height cannot import the constant.
    // If the two drift, content slides under the bar or a strip opens above it.
    const source = readFileSync(new URL("./meeting-top-bar.tsx", import.meta.url), "utf8");
    expect(source).toContain(`height: ${DESKTOP_TOP_BAR_HEIGHT_PX},`);
  });
});
