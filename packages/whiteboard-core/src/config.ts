/**
 * Values that every Whiteboard participant must apply identically.
 *
 * CANONICAL PAGE SIZE: a fixed 16:9 page (1200×675) on every device, so content
 * drawn on one looks identical on another. Each device fits the page width
 * inside its usable canvas band on entry; the page itself never changes size,
 * only the local camera adapts.
 *
 * 16:9, not the 4:3 this shipped with: every screen a meeting runs on is
 * widescreen, and a 4:3 page fitted into one is height-limited — it left a
 * couple of hundred pixels of dead canvas down each side and squeezed the
 * drawable area into the middle. Widescreen page, widescreen screen, no
 * gutters. Pages already drawn keep the height stored on their own frame
 * shape, so old boards still render exactly as they were authored.
 */
export const WHITEBOARD_CONFIG = {
  PAGE_WIDTH: 1200,
  PAGE_HEIGHT: 675,
  PAGE_SPACING: 40,
  CAMERA_PADDING: 40,
  MAX_PAGES: 100,
  ZOOM_STEPS: [0.5, 0.75, 1, 1.5, 2, 3, 4],
  MAX_ROOM_WRITE_BYTES: 20 * 1024 * 1024,
  MAX_SNAPSHOT_BYTES: 25 * 1024 * 1024,
  MAX_CLIENT_MESSAGE_BYTES: 16 * 1024 * 1024,
  // The sync server's WebSocket frame ceiling (its `maxPayload`). Client
  // chunking and server admission must share this value or a config change can make every large message fail.
  MAX_CLIENT_FRAME_BYTES: 1 * 1024 * 1024,
  // Presence is broadcast to every peer and is never persisted. Keep it far
  // below the document-message ceiling so one cursor update cannot become a
  // room-wide memory and bandwidth amplifier.
  MAX_PRESENCE_MESSAGE_BYTES: 16 * 1024,
  // The ceiling on what a session's presence record may RETAIN, not on what one
  // message may carry. Patches merge into the per-session record until the
  // session closes, so per-message limits alone let 40 in-cap patches retain
  // hundreds of KiB and fan it out to every peer forever. The live room
  // enforces this by measuring the merged record and evicting sessions that
  // breach it (the client republishes fresh state, the same recovery a
  // reconnect uses). Sized so a large-but-legitimate selection with a few
  // strokes in flight still fits with room to spare.
  MAX_RETAINED_PRESENCE_BYTES: 32 * 1024,
  // Defense-in-depth on top of the per-session ceiling: the whole room's
  // retained presence. A normal cursor-only record is a couple of KiB, so this
  // holds every socket of a full room (500 connections) many times over while
  // still bounding the worst case well below the document ceiling.
  MAX_TOTAL_RETAINED_PRESENCE_BYTES: 2 * 1024 * 1024,
  // A page's label, whether it lives on a native tldraw page record or on a
  // page-frame shape. The live room and the snapshot validator have to agree:
  // a restore that plants names the room would refuse produces a document
  // nobody can subsequently edit back into policy.
  MAX_PAGE_NAME_LENGTH: 255,
  MAX_BOOKMARK_TITLE_LENGTH: 512,
  MAX_BOOKMARK_DESCRIPTION_LENGTH: 2048,
  CLIENT_INGRESS_HEADROOM_BYTES: 8 * 1024 * 1024,
  CLIENT_INGRESS_BYTES_PER_SECOND: 24 * 1024 * 1024,
} as const;
