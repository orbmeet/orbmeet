import { defineWhiteboardServiceEndpoints } from "@orbmeet/whiteboard-client/react";

/**
 * Web-application API routes the whiteboard client consumes.
 *
 * This is the only place the app declares them; the whiteboard package never
 * invents application routes. Keep these in sync with the handlers mounted in
 * `modules/whiteboards/server/http/handler.ts` — the
 * `whiteboard-service-endpoints.test.ts` pins both sides.
 */
export const WHITEBOARD_APP_SERVICE_ROUTES = {
  recorderAuth: "/api/whiteboard/recorder-auth",
} as const;

/**
 * Validated adapter supplied to every whiteboard mount point
 * (`SyncedWhiteboard`, `RecorderWhiteboard`). Import this singleton at the
 * integration callsite instead of threading route strings through props.
 */
export const whiteboardServiceEndpoints = defineWhiteboardServiceEndpoints(
  WHITEBOARD_APP_SERVICE_ROUTES,
);
