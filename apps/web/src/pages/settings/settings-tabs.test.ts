import { describe, expect, it } from "vitest";
import { settingsPageOf } from "./settings-tabs";

describe("settingsPageOf", () => {
  it("opens old section links on the page that section now lives on", () => {
    expect(settingsPageOf(undefined)).toBe("settings");
    expect(settingsPageOf("privacy")).toBe("settings");
    expect(settingsPageOf("active-sessions")).toBe("account");
    expect(settingsPageOf("danger-zone")).toBe("account");
    expect(settingsPageOf("organization")).toBe("billing");
  });
});
