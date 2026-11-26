import { describe, expect, it } from "vitest";
import { REMOTE_NODE_DIR } from "./catalog.ts";
import { loadInventory } from "./inventory.ts";
import { deployScript, requireRsync } from "./remote.ts";
import { OpsError, type Shell } from "./shell.ts";
import { INVENTORY } from "./test-fixtures.ts";

const reporting = (output: string): Shell => async () => output;

describe("deployScript", () => {
  it("quotes empty and special-character arguments safely", async () => {
    const seen: (readonly string[])[] = [];
    const shell: Shell = async (argv) => {
      seen.push(argv);
      return "";
    };
    const inv = loadInventory(INVENTORY);
    await deployScript(shell, inv, "my1", ["apply", "", "a'b c"]);
    expect(seen[0].at(-1)).toBe(`sudo -n bash ${REMOTE_NODE_DIR}/deploy.sh apply '' 'a'"'"'b c'`);
  });
});

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
