import { describe, expect, it, vi } from "vitest";
import { handOffBoard } from "./whiteboard-handoff";

const noWait = () => Promise.resolve();

describe("handOffBoard", () => {
  it("hands the board straight to someone who can write", async () => {
    const grant = vi.fn();
    const setController = vi.fn(() => Promise.resolve());
    const result = await handOffBoard(
      { userId: "u1", userName: "Ada", principalKey: "user:u1", canEdit: true },
      { grant, setController, wait: noWait },
    );
    expect(result).toBeNull();
    expect(grant).not.toHaveBeenCalled();
    expect(setController).toHaveBeenCalledWith("u1");
  });

  it("gives a reader edit access first, and waits for it to land", async () => {
    const order: string[] = [];
    let refusals = 2;
    const result = await handOffBoard(
      { userId: "u2", userName: "Bo", principalKey: "guest_admission:g2", canEdit: false },
      {
        grant: async (key) => void order.push(`grant ${key}`),
        setController: async (userId) => {
          order.push(`set ${userId}`);
          if (refusals-- > 0) throw new Error("Grant whiteboard edit access before handing over presenting");
        },
        wait: noWait,
      },
    );
    expect(result).toBeNull();
    expect(order).toEqual(["grant guest_admission:g2", "set u2", "set u2", "set u2"]);
  });

  it("says so when the hand-off fails, instead of failing silently", async () => {
    const refused = () => Promise.reject(new Error("conflict"));
    expect(
      await handOffBoard({ userId: "u3", userName: "Cy", canEdit: true }, { setController: refused, wait: noWait }),
    ).toBe("Couldn't hand the board to Cy.");
    expect(
      await handOffBoard(
        { userId: "u3", userName: "Cy", principalKey: "user:u3", canEdit: false },
        { grant: () => Promise.resolve(), setController: refused, wait: noWait, grantWaitMs: 1_000 },
      ),
    ).toBe("Couldn't hand the board to Cy.");
    expect(
      await handOffBoard(
        { userId: "u3", userName: "Cy", principalKey: "user:u3", canEdit: false },
        { grant: () => Promise.reject(new Error("forbidden")), setController: refused, wait: noWait },
      ),
    ).toBe("Couldn't give Cy edit access.");
    expect(
      await handOffBoard({ userId: "u3", userName: "Cy", canEdit: false }, { setController: refused, wait: noWait }),
    ).toBe("Cy can't write on the board yet. Give them edit access first.");
  });
});
