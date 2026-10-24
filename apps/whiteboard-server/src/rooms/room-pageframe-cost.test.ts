import { createTestRoom } from "./room-test-support.ts";
import { whiteboardTLSchema } from "@orbmeet/whiteboard-core/room-schema";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TLSocketRoom } from "@tldraw/sync-core";
import * as syncCore from "@tldraw/sync-core";
// Runtime protocol helper is marked internal and omitted from published types.
const { getTlsyncProtocolVersion } = syncCore as unknown as { getTlsyncProtocolVersion(): number };
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TldrawSocket, SocketSession } from "./room-types.ts";
import type { WhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";

const tempDirs: string[] = [];
function makeDataDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "orbmeet-scratch-pageframe-"));
	tempDirs.push(dir);
	return dir;
}

function makeSocket(readyState = 1): TldrawSocket & { sent: string[] } {
	const sent: string[] = [];
	return {
		sent,
		readyState,
		send: (data: string | Uint8Array) => {
			sent.push(typeof data === "string" ? data : "binary");
		},
		close: () => {},
	};
}

function makeWsData(
	whiteboardRoomId: WhiteboardRoomId,
	sessionId: string,
	userId: string,
): SocketSession {
	return {
		tldrawSessionId: sessionId,
		userId,
		userName: `User ${userId}`,
		role: "participant",
		capabilities: {
			canEditWhiteboard: true,
			canControlSurface: true,
			canManageWhiteboard: true,
		},
		grantPrincipal: { type: "user", id: userId },
		whiteboardRoomId,
		connectionId: `conn-${userId}`,
	};
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("page-frame mutation cost", () => {
	it("keeps page-frame updates independent of full-document size", async () => {
		const spy = vi.spyOn(TLSocketRoom.prototype, "getCurrentSnapshot");
		const whiteboardRoomId = "meet-scratch-pf" as WhiteboardRoomId;
		const room = createTestRoom(whiteboardRoomId, makeDataDir(), vi.fn());

		const socket = makeSocket();
		const data = makeWsData(whiteboardRoomId, "manager-1:sess", "manager-1");
		room.handleConnect(socket, data);

		// Complete the tldraw connect handshake.
		room.handleMessage(data.tldrawSessionId, JSON.stringify({type:"connect", protocolVersion:getTlsyncProtocolVersion(),schema:whiteboardTLSchema.serialize(),connectRequestId:"confirm",lastServerClock:-1}));

		spy.mockClear();

		// A page-frame record id that exists in the document (created at open) is
		// the manager-gated class. Any put touching it is accepted for a manager.
		// We do not know the real frame id here, so instead prove the mechanism:
		// create a real page frame through the server's own page-add command, then
		// patch it from the socket.
		const added = room.addPage("manager-1");
		expect(added.ok).toBe(true);
		const pageFrameId = added.ok ? added.page.pageId : null;
		expect(pageFrameId).toBeTruthy();

		spy.mockClear();
		const messages = 50;
		for (let i = 0; i < messages; i += 1) {
			room.handleMessage(
				data.tldrawSessionId,
				JSON.stringify({
					type: "push",
					clientClock: i + 1,
					diff: {
						[pageFrameId as string]: [
							"patch",
							{ props: { name: ["put", `Page ${i}`] } },
						],
					},
				}),
			);
		}

		expect(spy).not.toHaveBeenCalled();
		room.close();
	});

	it("charges a viewer nothing and forwards presence-only after narrowing", async () => {
		const spy = vi.spyOn(TLSocketRoom.prototype, "getCurrentSnapshot");
		const whiteboardRoomId = "meet-scratch-view" as WhiteboardRoomId;
		const room = createTestRoom(whiteboardRoomId, makeDataDir(), vi.fn());
		const socket = makeSocket();
		const data = makeWsData(whiteboardRoomId, "viewer-1:sess", "viewer-1");
		data.capabilities = {
			canEditWhiteboard: false,
			canControlSurface: false,
			canManageWhiteboard: false,
		};
		room.handleConnect(socket, data);
		room.handleMessage(data.tldrawSessionId, JSON.stringify({type:"connect", protocolVersion:getTlsyncProtocolVersion(),schema:whiteboardTLSchema.serialize(),connectRequestId:"confirm",lastServerClock:-1}));
		spy.mockClear();

		for (let i = 0; i < 20; i += 1) {
			room.handleMessage(
				data.tldrawSessionId,
				JSON.stringify({
					type: "push",
					clientClock: i + 1,
					diff: { "shape:fake": ["put", { id: "shape:fake", typeName: "shape" }] },
					presence: ["put", { userId: "spoofed", userName: "spoof" }],
				}),
			);
		}
		expect(spy.mock.calls.length).toBe(0);
		room.close();
	});
});
