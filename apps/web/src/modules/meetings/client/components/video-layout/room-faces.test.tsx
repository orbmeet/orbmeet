import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const room = vi.hoisted(() => ({
  participants: [] as { identity: string; name: string; isLocal: boolean }[],
  speaking: [] as string[],
  cameras: [] as string[],
}));

vi.mock("@livekit/components-react", () => ({
  useParticipants: () => room.participants,
  useSpeakingParticipants: () => room.participants.filter((p) => room.speaking.includes(p.identity)),
  useIsSpeaking: (participant: { identity: string }) => room.speaking.includes(participant.identity),
  useIsMuted: () => false,
  useParticipantAttribute: () => undefined,
}));
vi.mock("./tracks", () => ({
  useActiveVideoTracks: () =>
    room.cameras.map((identity) => ({ participant: { identity }, source: "camera", publication: undefined })),
}));
vi.mock("../meeting-video-track", () => ({ MeetingVideoTrack: () => null }));
vi.mock("../people-facepile", () => ({ PeopleFacepile: () => null }));

const { RoomFaces } = await import("./room-faces");

function person(identity: string, name: string, isLocal = false) {
  return { identity, name, isLocal };
}

function render(
  raisedHands: string[],
  onCallOn?: (userId: string) => void,
  variant: "column" | "row" = "column",
) {
  const hands = raisedHands.map((userId) => ({
    userId,
    userName: room.participants.find((p) => p.identity === userId)?.name ?? userId,
  }));
  return renderToStaticMarkup(
    <RoomFaces variant={variant} raisedHands={hands} onShowEveryone={() => {}} onCallOn={onCallOn} />,
  );
}

describe("RoomFaces", () => {
  it("shows hands first, you last, and everyone else behind +N under a board", () => {
    room.participants = [
      person("me", "Atiq Rahman", true),
      person("maya", "Maya Kim"),
      person("sam", "Sam Ortiz"),
      person("alex", "Alex Lin"),
      person("fayaz", "Fayaz Ahmed"),
    ];
    room.speaking = [];
    const markup = render(["fayaz"], undefined, "row");

    const shown = [...markup.matchAll(/<div role="img" aria-label="([^"]+)"/g)].map((match) => match[1]);
    expect(shown).toHaveLength(3);
    expect(shown[0]).toBe("Fayaz Ahmed, hand raised");
    expect(shown[2]).toBe("You");
    expect(shown.join(" ")).not.toContain("Atiq");
    // Four others here, two of them shown beside you.
    expect(markup).toContain(">+2<");
    expect(markup).toContain('aria-label="Show everyone, 5 in the meeting"');
  });

  it("has room for everyone and you beside a board, over the Conversation", () => {
    room.participants = [
      person("me", "Atiq Rahman", true),
      person("maya", "Maya Kim"),
      person("sam", "Sam Ortiz"),
      person("alex", "Alex Lin"),
      person("fayaz", "Fayaz Ahmed"),
    ];
    room.speaking = [];
    const markup = render([]);
    // Four others and you: the count over them is the faces under it.
    expect([...markup.matchAll(/<div role="img"/g)]).toHaveLength(5);
    expect(markup).toContain('aria-label="You"');
    expect(markup).not.toContain("Show everyone");
    expect(markup).toContain("In the room");
  });

  it("puts people with their camera on ahead of silent ones without, whoever joined first", () => {
    room.participants = [
      person("me", "Atiq Rahman", true),
      person("maya", "Maya Kim"),
      person("sam", "Sam Ortiz"),
      person("alex", "Alex Lin"),
      person("incogni", "Incogni"),
    ];
    room.speaking = [];
    room.cameras = ["incogni"];
    const shown = [...render([]).matchAll(/<div role="img" aria-label="([^"]+)"/g)].map((match) => match[1]);
    expect(shown[0]).toBe("Incogni");
    room.cameras = [];
  });

  it("keeps whoever is talking in view ahead of a silent camera", () => {
    room.participants = [
      person("me", "Atiq Rahman", true),
      person("maya", "Maya Kim"),
      person("sam", "Sam Ortiz"),
      person("alex", "Alex Lin"),
      person("cam", "Cam Era"),
    ];
    room.speaking = ["alex"];
    room.cameras = ["cam"];
    const shown = [...render([]).matchAll(/<div role="img" aria-label="([^"]+)"/g)].map((match) => match[1]);
    expect(shown.slice(0, 2)).toEqual(["Alex Lin, talking", "Cam Era"]);
    room.speaking = [];
    room.cameras = [];
  });

  it("marks whoever is talking", () => {
    room.participants = [person("me", "Atiq Rahman", true), person("maya", "Maya Kim")];
    room.speaking = ["maya"];
    expect(render([])).toContain('aria-label="Maya Kim, talking"');
  });

  it("names the hands in turn for whoever can call on them, and no one else", () => {
    room.participants = [person("me", "Atiq Rahman", true), person("alex", "Alex Lin"), person("fayaz", "Fayaz Ahmed")];
    room.speaking = [];
    const moderator = render(["alex", "fayaz"], () => {});
    expect(moderator).toContain("Alex</span>, then Fayaz");
    expect(moderator).toContain('aria-label="Let Alex Lin speak"');
    expect(moderator).toContain("Call on Alex");
    expect(render(["alex", "fayaz"])).not.toContain("Call on");
  });

  it("keeps a recording's faces free of controls", () => {
    room.participants = [person("me", "Recorder", true), person("alex", "Alex Lin"), person("fayaz", "Fayaz Ahmed")];
    room.speaking = [];
    const hands = [{ userId: "alex", userName: "Alex Lin" }];
    const markup = renderToStaticMarkup(
      <RoomFaces variant="column" readOnly raisedHands={hands} onShowEveryone={() => {}} onCallOn={() => {}} />,
    );
    expect(markup).toContain("Alex Lin, hand raised");
    expect(markup).not.toContain("<button");
    // The recorder is the recording's own participant, not a face in it.
    expect(markup).not.toContain('aria-label="You"');
  });

  it("shows nothing when you are alone", () => {
    room.participants = [person("me", "Atiq Rahman", true)];
    room.speaking = [];
    expect(render([])).toBe("");
  });
});
