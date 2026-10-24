import { describe, expect, it } from "vitest";

import {
  WHITEBOARD_APP_SERVICE_ROUTES,
  whiteboardServiceEndpoints,
} from "./whiteboard-service-endpoints";

/**
 * Drift alarm between the whiteboard client's service-endpoint adapter and the
 * routes this app actually mounts in
 * `modules/whiteboards/server/http/handler.ts`. If either side moves a path,
 * this test fails and forces both sides to be reconciled deliberately.
 */
describe("whiteboardServiceEndpoints", () => {
  it("pins every endpoint to the route the web server mounts", () => {
    expect(WHITEBOARD_APP_SERVICE_ROUTES).toEqual({
      recorderAuth: "/api/whiteboard/recorder-auth",
    });
  });

  it("exposes the validated adapter the whiteboard package consumes", () => {
    expect(whiteboardServiceEndpoints).toEqual(WHITEBOARD_APP_SERVICE_ROUTES);
    expect(Object.isFrozen(whiteboardServiceEndpoints)).toBe(true);
  });
});
