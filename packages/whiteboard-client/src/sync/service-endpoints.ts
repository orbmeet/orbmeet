import { WHITEBOARD_SYNC_ROUTES } from "@orbmeet/whiteboard-core/protocol";

/**
 * Endpoints of the host application that the whiteboard client talks to.
 *
 * The package never invents routes. Sync-server wire paths are protocol
 * constants owned by the shared contract (`WHITEBOARD_SYNC_ROUTES` in
 * `@orbmeet/whiteboard-core/protocol`); every host-application endpoint is
 * supplied through this adapter by the integration layer and validated
 * eagerly with {@link defineWhiteboardServiceEndpoints}, so a configuration
 * mistake fails at integration time instead of as an opaque fetch failure.
 */
export interface WhiteboardServiceEndpoints {
  /** Recorder-token exchange that mints a read-only board JWT (POST). */
  recorderAuth: string;
}

const ENDPOINT_KEYS = [
  "recorderAuth",
] as const satisfies readonly (keyof WhiteboardServiceEndpoints)[];

/**
 * Validate and freeze a host-supplied service-endpoint adapter. Throws a
 * descriptive error naming every missing or empty endpoint.
 */
export function defineWhiteboardServiceEndpoints(
  endpoints: WhiteboardServiceEndpoints,
): Readonly<WhiteboardServiceEndpoints> {
  const source = endpoints as unknown as Partial<Record<string, unknown>> | null | undefined;
  const missing = ENDPOINT_KEYS.filter((key) => {
    const value = source?.[key];
    return typeof value !== "string" || value.trim() === "";
  });
  if (missing.length > 0) {
    throw new Error(
      `Whiteboard service endpoints are not configured (missing: ${missing.join(", ")}). ` +
        "The host application must supply all service routes via " +
        "defineWhiteboardServiceEndpoints({ recorderAuth }).",
    );
  }
  return Object.freeze({ ...endpoints });
}

/**
 * Resolve a sync-server wire route against the server's base URL. Route paths
 * are root-relative protocol constants, so the base is treated as an origin.
 */
export function whiteboardSyncUrl(baseUrl: string, route: string): string {
  return new URL(route, baseUrl).toString();
}

/**
 * Build the sync server's WebSocket connect URL, minting the protocol and
 * carrying the auth token in the fragment (it is never sent to intermediaries).
 */
export function buildWhiteboardConnectUrl(baseUrl: string, token: string): string {
  const url = new URL(WHITEBOARD_SYNC_ROUTES.connect, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.hash = new URLSearchParams({ token }).toString();
  return url.toString();
}
