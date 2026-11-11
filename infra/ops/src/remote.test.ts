import { describe, expect, it } from "vitest";
import { requireRsync } from "./remote.ts";
import { OpsError, type Shell } from "./shell.ts";

const reporting = (output: string): Shell => async () => output;

describe("requireRsync", () => {
  it("accepts rsync itself, old or new", async () => {
    await expect(requireRsync(reporting("rsync  version 3.4.1  protocol version 32\n"))).resolves.toBeUndefined();
    await expect(requireRsync(reporting("rsync  version 2.6.9  protocol version 29\n"))).resolves.toBeUndefined();
  });

  it("refuses macOS's openrsync, which skips deletions with --relative", async () => {
    const openrsync = reporting("openrsync: protocol version 29\nrsync version 2.6.9 compatible\n");
    await expect(requireRsync(openrsync)).rejects.toThrow(OpsError);
    await expect(requireRsync(openrsync)).rejects.toThrow(/openrsync: protocol version 29/);
  });
});
