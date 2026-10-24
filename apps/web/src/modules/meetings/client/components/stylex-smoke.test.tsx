import { describe, expect, it } from "vitest";
import { SpaceRow } from "@/modules/spaces/client/components/space-row";

describe("stylex smoke", () => {
  it("compiles modules that use when.ancestor", () => {
    // Importing is the assertion: an uncompiled `when.ancestor` throws while
    // the module initializes, before a component can render.
    expect(SpaceRow).toBeTypeOf("function");
  });
});
