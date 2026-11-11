import type { Room } from "livekit-client";
import { describe, expect, it, vi } from "vitest";
import { followMeetingSpeaker } from "./use-meeting-ui";

const outputSelection = vi.hoisted(() => ({ supported: true }));
vi.mock("./speaker-test", () => ({ canSelectAudioOutput: () => outputSelection.supported }));

describe("followMeetingSpeaker", () => {
  const roomOn = (deviceId: string | undefined) =>
    ({ getActiveDevice: (kind: string) => (kind === "audiooutput" ? deviceId : undefined) }) as unknown as Room;
  const element = (sinkId = "") => {
    const audio = { sinkId, setSinkId: vi.fn(async (id: string) => { audio.sinkId = id; }) };
    return audio as unknown as HTMLAudioElement & { setSinkId: ReturnType<typeof vi.fn> };
  };

  it("plays on the speaker the meeting's voices use", async () => {
    outputSelection.supported = true;
    const audio = element();
    await followMeetingSpeaker(audio, roomOn("headset"));
    expect(audio.setSinkId).toHaveBeenCalledWith("headset");
  });

  it("returns to the default speaker when the meeting does", async () => {
    outputSelection.supported = true;
    const audio = element("headset");
    await followMeetingSpeaker(audio, roomOn(undefined));
    expect(audio.setSinkId).toHaveBeenCalledWith("");
  });

  it("leaves the element alone where the meeting offers no speaker choice", async () => {
    outputSelection.supported = false;
    const audio = element();
    await followMeetingSpeaker(audio, roomOn("headset"));
    expect(audio.setSinkId).not.toHaveBeenCalled();
  });
});
