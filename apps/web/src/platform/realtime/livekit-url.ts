/** Convert a LiveKit WebSocket URL into the HTTP endpoint used by server SDKs. */
export function livekitHttpUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol === "ws:") parsed.protocol = "http:";
  else if (parsed.protocol === "wss:") parsed.protocol = "https:";
  return parsed.toString().replace(/\/$/, "");
}
