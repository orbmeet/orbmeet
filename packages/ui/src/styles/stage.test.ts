import * as stylex from "@stylexjs/stylex";
import { describe, expect, it } from "vitest";

import { stageChrome } from "./stage";

describe("stageChrome", () => {
  it("publishes final safe-area expressions in the runtime scope", () => {
    const props = stylex.props(stageChrome.publish("48px", "72px", "240px", "0px"));
    const values = Object.values(props.style ?? {});

    expect(values).toContain("calc(env(safe-area-inset-top, 0px) + 48px)");
    expect(values).toContain("calc(env(safe-area-inset-bottom, 0px) + 72px)");
    expect(values).toContain("calc(env(safe-area-inset-right, 0px) + 240px)");
  });

  it("publishes the side-panel reservation so the stage can shrink for it", () => {
    const open = stylex.props(
      stageChrome.publish("48px", "72px", "0px", "calc(320px + 1.5rem)"),
    );
    expect(Object.values(open.style ?? {})).toContain("calc(320px + 1.5rem)");

    const closed = stylex.props(stageChrome.publish("48px", "72px", "0px", "0px"));
    expect(Object.values(closed.style ?? {})).toContain("0px");
  });
});
