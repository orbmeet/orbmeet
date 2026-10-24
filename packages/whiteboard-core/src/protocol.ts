export const WHITEBOARD_EVENTS = {
  STATE: "whiteboard.state",
  ACCESS_REQUESTED: "whiteboard.access.requested",
  ACCESS_GRANTED: "whiteboard.access.granted",
  ACCESS_DENIED: "whiteboard.access.denied",
  ROOM_SIZE_LIMIT: "whiteboard.room-size-limit",
  ROOM_SIZE_RECOVERED: "whiteboard.room-size-recovered",
  PRESENCE_RESYNC: "whiteboard.presence.resync",
} as const;

/**
 * Route paths of the whiteboard sync server. These are wire-protocol
 * constants — the sync server and every client must agree on them — so they
 * live in this shared contract instead of being restated as literals at each
 * callsite. Host-application endpoints (e.g. the web app's recorder auth) are
 * *not* protocol and belong to the host's service-endpoint adapter instead
 * (see `@orbmeet/whiteboard-client` `WhiteboardServiceEndpoints`).
 */
export const WHITEBOARD_SYNC_ROUTES = {
  /** WebSocket upgrade endpoint. */
  connect: "/connect",
  /** GET: the assistant conversation. POST: an `AssistantRequest`. */
  assistant: "/assistant",
  /** POST: unfurl a URL into bookmark metadata. */
  unfurl: "/unfurl",
  /** POST: start a PDF import, which places its pages on the board as they render. */
  pdfImport: "/pdf-import",
} as const;

/** Route of one PDF import: GET reads its progress, DELETE cancels it. */
export function whiteboardPdfImportRoute(importId: string): string {
  return `${WHITEBOARD_SYNC_ROUTES.pdfImport}/${importId}`;
}

/** Authoritative reconciliation for the viewer's local access-request UI. */
export function reconcileEditAccessRequestPending(
  canEditWhiteboard: boolean,
  serverPending: unknown,
): boolean {
  return !canEditWhiteboard && serverPending === true;
}
