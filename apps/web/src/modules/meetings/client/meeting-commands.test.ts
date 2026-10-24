import { describe, expect, it, vi } from "vitest";
import { isCommandPaletteShortcut } from "./meeting-command-shortcut";
import {
  buildMeetingCommands,
  matchMeetingCommands,
  type MeetingCommandInput,
} from "./meeting-commands";

function input(overrides: Partial<MeetingCommandInput> = {}): MeetingCommandInput {
  const noop = () => {};
  return {
    mic: { on: false, toggle: noop },
    camera: { on: false, toggle: noop },
    screenShare: { sharing: false, toggle: noop },
    speech: { shown: true, toggle: noop },
    captions: { shown: false, toggle: noop },
    timeline: { open: false, toggle: noop },
    people: { open: false, toggle: noop },
    copyLink: noop,
    leave: noop,
    ...overrides,
  };
}

const ids = (commands: { id: string }[]) => commands.map((command) => command.id);

describe("buildMeetingCommands", () => {
  it("phrases every toggle as what it will do next", () => {
    const off = buildMeetingCommands(input());
    expect(off.find((c) => c.id === "mic")?.label).toBe("Unmute microphone");
    expect(off.find((c) => c.id === "camera")?.label).toBe("Turn camera on");

    const on = buildMeetingCommands(input({ mic: { on: true, toggle: () => {} }, camera: { on: true, toggle: () => {} } }));
    expect(on.find((c) => c.id === "mic")?.label).toBe("Mute microphone");
    expect(on.find((c) => c.id === "camera")?.label).toBe("Turn camera off");
  });

  it("offers nothing the bar would refuse", () => {
    // No hand for a moderator, no record or lock for someone who cannot,
    // no end-for-everyone for a participant: absent, not disabled.
    const commands = ids(buildMeetingCommands(input()));
    expect(commands).not.toContain("hand");
    expect(commands).not.toContain("record");
    expect(commands).not.toContain("lock");
    expect(commands).not.toContain("end");
    expect(commands).toContain("leave");
  });

  it("offers the other view, never the one you are in", () => {
    const surface = { label: "Whiteboard", onShowBoard: () => {}, onShowTalk: () => {} };
    expect(ids(buildMeetingCommands(input({ surface: { ...surface, active: false } })))).toContain("view-board");
    const onBoard = ids(buildMeetingCommands(input({ surface: { ...surface, active: true } })));
    expect(onBoard).toContain("view-talk");
    expect(onBoard).not.toContain("view-board");
  });

  it("only offers board navigation while the board is on stage", () => {
    const follow = { presenterName: "Maya", following: true, onFollow: () => {}, onStopFollowing: () => {} };
    const base = { label: "Whiteboard", follow, onSync: () => {} };
    expect(ids(buildMeetingCommands(input({ surface: { ...base, active: false } })))).not.toContain("board-unfollow");
    const shown = ids(buildMeetingCommands(input({ surface: { ...base, active: true } })));
    expect(shown).toContain("board-unfollow");
    expect(shown).toContain("board-sync");
  });

  it("names the presenter in both directions of follow", () => {
    const run = vi.fn();
    const following = buildMeetingCommands(
      input({
        surface: {
          label: "Whiteboard",
          active: true,
          follow: { presenterName: "Maya", following: true, onFollow: () => {}, onStopFollowing: run },
        },
      }),
    ).find((c) => c.id === "board-unfollow");
    expect(following?.label).toBe("Stop following Maya");
    following?.run();
    expect(run).toHaveBeenCalledOnce();

    const detached = buildMeetingCommands(
      input({
        surface: {
          label: "Whiteboard",
          active: true,
          follow: { presenterName: "Maya", following: false, onFollow: () => {}, onStopFollowing: () => {} },
        },
      }),
    );
    expect(detached.find((c) => c.id === "board-follow")?.label).toBe("Follow Maya");
  });

  it("lets a running recording be stopped even when starting one is blocked", () => {
    const toggle = () => {};
    const running = buildMeetingCommands(
      input({ recording: { recording: true, disabledReason: "Stop the live stream first", toggle } }),
    ).find((c) => c.id === "record");
    expect(running?.disabled).toBe(false);

    const blocked = buildMeetingCommands(
      input({ recording: { recording: false, disabledReason: "Only a Meeting manager can record", toggle } }),
    ).find((c) => c.id === "record");
    expect(blocked?.disabled).toBe(true);
    expect(blocked?.hint).toBe("Only a Meeting manager can record");
  });
});

describe("matchMeetingCommands", () => {
  const commands = buildMeetingCommands(
    input({
      hand: { raised: false, toggle: () => {} },
      recording: { recording: true, disabledReason: null, toggle: () => {} },
      endForEveryone: () => {},
    }),
  );

  it("lists everything, grouped, for an empty query", () => {
    const all = matchMeetingCommands(commands, "  ");
    expect(all).toHaveLength(commands.length);
    // Grouped: collapse runs of the same group, and no group may appear twice.
    const runs = all.map((c) => c.group).filter((group, index, groups) => group !== groups[index - 1]);
    expect(new Set(runs).size).toBe(runs.length);
  });

  it("puts a label that starts with the query first", () => {
    expect(matchMeetingCommands(commands, "le")[0]?.id).toBe("leave");
  });

  it("requires every term to match", () => {
    expect(ids(matchMeetingCommands(commands, "stop rec"))).toEqual(["record"]);
  });

  it("finds a command by what people call it, not only by its label", () => {
    expect(ids(matchMeetingCommands(commands, "mute"))).toContain("mic");
    expect(ids(matchMeetingCommands(commands, "hang up"))).toEqual(expect.arrayContaining(["leave", "end"]));
  });

  it("returns nothing rather than everything for a query nothing matches", () => {
    expect(matchMeetingCommands(commands, "photosynthesis")).toEqual([]);
  });
});

describe("isCommandPaletteShortcut", () => {
  const key = (overrides: Partial<KeyboardEvent>) => ({
    key: "k",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  });

  it("accepts Cmd+K and Ctrl+K", () => {
    expect(isCommandPaletteShortcut(key({ metaKey: true }))).toBe(true);
    expect(isCommandPaletteShortcut(key({ ctrlKey: true, key: "K" }))).toBe(true);
  });

  it("ignores a bare K and other chords", () => {
    expect(isCommandPaletteShortcut(key({}))).toBe(false);
    expect(isCommandPaletteShortcut(key({ metaKey: true, shiftKey: true }))).toBe(false);
    expect(isCommandPaletteShortcut(key({ metaKey: true, key: "j" }))).toBe(false);
  });
});

describe("people in the palette", () => {
  it("calls on raised hands in turn, and writes to anyone privately", () => {
    const callOn = vi.fn();
    const open = vi.fn();
    const commands = buildMeetingCommands(
      input({
        hands: { queue: [{ userId: "alex", userName: "Alex Lin" }, { userId: "fayaz", userName: "Fayaz Ahmed" }], callOn },
        messagePrivately: { people: [{ id: "fayaz", name: "Fayaz Ahmed" }], open },
      }),
    );
    const people = commands.filter((command) => command.group === "People");
    expect(people.map((command) => [command.label, command.hint])).toEqual([
      ["Call on Alex Lin", "First in line"],
      ["Call on Fayaz Ahmed", "2nd in line"],
      ["Message Fayaz Ahmed privately", "Only the two of you see it"],
    ]);
    people[0].run();
    people[2].run();
    expect(callOn).toHaveBeenCalledWith("alex");
    expect(open).toHaveBeenCalledWith({ id: "fayaz", name: "Fayaz Ahmed" });
    expect(matchMeetingCommands(commands, "ca")[0].label).toBe("Call on Alex Lin");
  });
});
