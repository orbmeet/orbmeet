import { describe, expect, it } from "vitest";
import {
  handRaiseControl,
  selectDockGroups,
  type DockActionId,
  type DockActionsInput,
} from "./dock-actions";

const BASE: DockActionsInput = {
  isHost: false,
  handRaise: { isHandRaised: false, queue: null },
  canChooseExistingSurface: false,
  isScreenSharing: false,
  canConfigureAudio: false,
  backgroundSupported: false,
  canRecord: false,
  isRecording: false,
  recordingDisabled: false,
  canStream: false,
  isStreaming: false,
  streamingDisabled: false,
  countdownActive: false,
};

function idsIn(input: DockActionsInput, group: string): DockActionId[] {
  const found = selectDockGroups(input).find((g) => g.id === group);
  return found ? found.actions.map((action) => action.id) : [];
}

describe("selectDockGroups", () => {
  it("hides the host group entirely from participants", () => {
    expect(selectDockGroups(BASE).map((group) => group.id)).toEqual([
      "collaborate",
      "audio-video",
    ]);
  });

  it("drops a group rather than rendering an empty section", () => {
    // A participant with no hand-raise and no surface still gets a
    // collaborate group (share, timer), but never an empty heading.
    const groups = selectDockGroups({ ...BASE, handRaise: null });
    expect(groups.every((group) => group.actions.length > 0)).toBe(true);
  });

  it("orders collaborate actions by how often they are reached for", () => {
    expect(idsIn(BASE, "collaborate")).toEqual(["hand", "share", "timer"]);
  });

  it("leaves out what the dock and the header already carry", () => {
    // The Conversation and Talk/Board are dock buttons; People and the lock are
    // in the header. A row for each here would be the same control twice.
    const all = selectDockGroups({ ...BASE, isHost: true, canRecord: true })
      .flatMap((group) => group.actions.map((action) => action.label));
    expect(all).not.toContain("Conversation");
    expect(all).not.toContain("People");
    expect(all).not.toContain("Require approval to join");
  });

  it("turns captions on and off from the sheet, saying which it will do", () => {
    expect(idsIn(BASE, "audio-video")).not.toContain("captions");
    const off = selectDockGroups({ ...BASE, captionsShown: false }).flatMap((group) => group.actions);
    expect(off.find((action) => action.id === "captions")?.label).toBe("Show captions");
    const on = selectDockGroups({ ...BASE, captionsShown: true }).flatMap((group) => group.actions);
    expect(on.find((action) => action.id === "captions")).toMatchObject({ label: "Hide captions", active: true });
  });

  it("offers 'choose existing' only while the surface is closed", () => {
    const closed = { ...BASE, canChooseExistingSurface: true };
    expect(idsIn(closed, "collaborate")).toContain("surface-existing");
    expect(idsIn({ ...closed, surfaceActive: true }, "collaborate")).not.toContain(
      "surface-existing",
    );
  });

  it("labels stateful actions by the effect of selecting them", () => {
    // "Stop sharing" tells you what will happen; "Share" plus a highlight makes
    // you infer it. On a phone the label is the only affordance there is room for.
    const sharing = selectDockGroups({ ...BASE, isScreenSharing: true });
    const share = sharing[0].actions.find((action) => action.id === "share");
    expect(share?.label).toBe("Stop sharing");
    expect(share?.active).toBe(true);
  });

  it("carries current state as a detail line instead of hiding it", () => {
    const groups = selectDockGroups({
      ...BASE,
      backgroundSupported: true,
      backgroundLabel: "Blur",
      captionLanguageLabel: "English — United Kingdom",
    });
    const audioVideo = groups.find((group) => group.id === "audio-video");
    expect(audioVideo?.actions.find((a) => a.id === "background")?.detail).toBe("Blur");
    expect(audioVideo?.actions.find((a) => a.id === "caption-language")?.detail).toBe(
      "English — United Kingdom",
    );
  });

  it("offers the shared audio-device panel when device switching is available", () => {
    const groups = selectDockGroups({
      ...BASE,
      canConfigureAudio: true,
      audioDeviceLabel: "Studio microphone",
    });
    const audio = groups
      .find((group) => group.id === "audio-video")
      ?.actions.find((action) => action.id === "audio");
    expect(audio).toMatchObject({
      label: "Audio devices",
      detail: "Studio microphone",
      opensPanel: true,
    });
  });

  it("marks live host actions as danger so stopping them reads as destructive", () => {
    const groups = selectDockGroups({
      ...BASE,
      isHost: true,
      canRecord: true,
      isRecording: true,
      canStream: true,
      isStreaming: true,
    });
    const host = groups.find((group) => group.id === "host");
    expect(host?.actions.find((a) => a.id === "record")).toMatchObject({
      label: "Stop recording",
      danger: true,
    });
    expect(host?.actions.find((a) => a.id === "stream")).toMatchObject({
      label: "Stop stream",
      danger: true,
      // Stopping is immediate; starting needs the destination panel.
      opensPanel: false,
    });
  });

});

describe("hand raise queue signalling", () => {
  const moderator: DockActionsInput = {
    ...BASE,
    handRaise: { isHandRaised: false, queue: { open: true, pendingCount: 3 } },
  };
  const action = (input: DockActionsInput, id: string) =>
    selectDockGroups(input).flatMap((group) => group.actions).find((candidate) => candidate.id === id);

  it("gives a moderator no hand button of their own: it would only open the timeline again", () => {
    expect(action(moderator, "hand")).toBeUndefined();
  });

  it("stays a plain raise-hand toggle for anyone who cannot moderate", () => {
    expect(action(BASE, "hand")).toMatchObject({ label: "Raise hand", active: false });
    expect(action({ ...BASE, handRaise: { isHandRaised: true, queue: null } }, "hand"))
      .toMatchObject({ label: "Lower hand", active: true });
    expect(action(BASE, "hand")).toMatchObject(handRaiseControl({ isHandRaised: false }));
  });
});

describe("shared timer", () => {
  it("is offered to everyone, like on desktop, not only in host controls", () => {
    expect(idsIn(BASE, "collaborate")).toContain("timer");
    expect(idsIn({ ...BASE, isHost: true }, "host")).not.toContain("timer");
  });
});

describe("disabled explanations", () => {
  it("carries the recording reason into the phone action detail", () => {
    const groups = selectDockGroups({
      ...BASE,
      isHost: true,
      canRecord: true,
      recordingDisabled: true,
      recordingDisabledReason: "Recording is disabled for this meeting",
    });
    const record = groups.flatMap((group) => group.actions).find((action) => action.id === "record");
    expect(record).toMatchObject({
      disabled: true,
      detail: "Recording is disabled for this meeting",
    });
  });
});
