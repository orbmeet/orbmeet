// @vitest-environment jsdom
import { EventEmitter } from "node:events";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RoomEvent, type Room } from "livekit-client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

type Pending = { id: string; userId: string | null; displayName: string; role: string };
const answers: Array<(value: { pending: Pending[] }) => void> = [];
const listPendingAdmissions = vi.fn(
  () => new Promise<{ pending: Pending[] }>((resolve) => answers.push(resolve)),
);
const decideAdmission = vi.fn(async () => ({ success: true }));
vi.mock("@/modules/meetings/server/runtime/live.functions", () => ({ listPendingAdmissions, decideAdmission }));

const { useMeetingAdmissions } = await import("./use-meeting-admissions");
const { queryKeys } = await import("@/lib/query-keys");

let root: Root | null = null;
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  answers.length = 0;
  vi.clearAllMocks();
});

const alice: Pending = { id: "adm_alice", userId: null, displayName: "Alice", role: "attendee" };
const bob: Pending = { id: "adm_bob", userId: null, displayName: "Bob", role: "attendee" };

function roomAt(admissionsVersion: number) {
  const metadata = (version: number) => JSON.stringify({ version, admissionsVersion: version });
  const room = Object.assign(new EventEmitter(), { metadata: metadata(admissionsVersion) });
  return {
    room: room as unknown as Room,
    bump(version: number) {
      room.metadata = metadata(version);
      room.emit(RoomEvent.RoomMetadataChanged, room.metadata);
    },
  };
}

/** React Query hands results to observers on a timer of its own. */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

function mount(room: Room) {
  let latest: ReturnType<typeof useMeetingAdmissions> | null = null;
  function Probe() {
    latest = useMeetingAdmissions({ meetingId: "m", managerConnectionId: "c", canModerate: true, room, addToast: vi.fn() });
    return null;
  }
  const client = new QueryClient();
  root = createRoot(document.createElement("div"));
  act(() => root!.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>));
  return {
    client,
    waiting: () => latest!.hostPermissionRequests.map((request) => request.userName),
    admit: (admissionId: string) => latest!.handleApproveAdmission(admissionId),
  };
}

describe("useMeetingAdmissions", () => {
  it("shows the newest list when an older answer lands after it", async () => {
    const { room, bump } = roomAt(1); // Alice knocked
    const host = mount(room);
    await act(async () => {});
    act(() => bump(2)); // Bob knocked a moment later
    await act(async () => {});
    expect(listPendingAdmissions).toHaveBeenCalledTimes(2);

    answers[1]({ pending: [alice, bob] });
    await vi.waitFor(async () => {
      await settle();
      expect(host.waiting()).toEqual(["Alice", "Bob"]);
    });

    // The older answer lands, and is kept as what version 1 said …
    answers[0]({ pending: [alice] });
    await vi.waitFor(() => {
      expect(host.client.getQueryData(queryKeys.meetings.pendingAdmissions("m", "c", 1))).toEqual({ pending: [alice] });
    });
    await settle();
    // … without standing in for version 2.
    expect(host.waiting()).toEqual(["Alice", "Bob"]);
  });

  it("takes someone off the list as soon as they are let in", async () => {
    const { room } = roomAt(1);
    const host = mount(room);
    await act(async () => {});
    answers[0]({ pending: [alice, bob] });
    await vi.waitFor(async () => {
      await settle();
      expect(host.waiting()).toEqual(["Alice", "Bob"]);
    });

    await act(async () => host.admit(alice.id));

    expect(decideAdmission).toHaveBeenCalledWith({
      data: { meetingId: "m", admissionId: alice.id, approve: true, connectionId: "c" },
    });
    await vi.waitFor(async () => {
      await settle();
      expect(host.waiting()).toEqual(["Bob"]);
    });
  });

  it("keeps someone off the list when the room reports the change before the reply", async () => {
    const { room, bump } = roomAt(1);
    const host = mount(room);
    await act(async () => {});
    answers[0]({ pending: [alice, bob] });
    await vi.waitFor(async () => {
      await settle();
      expect(host.waiting()).toEqual(["Alice", "Bob"]);
    });

    let reply!: () => void;
    decideAdmission.mockImplementationOnce(() => new Promise((resolve) => { reply = () => resolve({ success: true }); }));
    let admitted!: Promise<void>;
    act(() => { admitted = host.admit(alice.id); });
    act(() => bump(2)); // Alice's admission bumps the version first
    await act(async () => {});
    await act(async () => { reply(); await admitted; });
    await settle();
    // Version 2's list has not landed; version 1's is still up, without Alice.
    expect(answers).toHaveLength(2);
    expect(host.waiting()).toEqual(["Bob"]);

    answers[1]({ pending: [bob] });
    await vi.waitFor(async () => {
      await settle();
      expect(host.waiting()).toEqual(["Bob"]);
    });
  });
});
