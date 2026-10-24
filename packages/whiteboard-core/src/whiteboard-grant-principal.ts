export const WHITEBOARD_EDIT_GRANT_PRINCIPAL_TYPES = [
  "user",
  "guest_admission",
] as const;

export type WhiteboardGrantPrincipalType =
  (typeof WHITEBOARD_EDIT_GRANT_PRINCIPAL_TYPES)[number];

export type WhiteboardGrantPrincipal =
  | { type: "user"; id: string }
  | { type: "guest_admission"; id: string };

const PRINCIPAL_ID_REGEX = /^[a-zA-Z0-9_-]{1,192}$/;

export function isWhiteboardGrantPrincipal(
  value: unknown,
): value is WhiteboardGrantPrincipal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as { type?: unknown; id?: unknown };
  return (
    (record.type === "user" || record.type === "guest_admission") &&
    typeof record.id === "string" &&
    PRINCIPAL_ID_REGEX.test(record.id)
  );
}

export function whiteboardGrantPrincipalKey(
  principal: WhiteboardGrantPrincipal,
): string {
  return `${principal.type}:${principal.id}`;
}

export function parseWhiteboardGrantPrincipalKey(
  value: string,
): WhiteboardGrantPrincipal | null {
  const separator = value.indexOf(":");
  if (separator <= 0) return null;
  const type = value.slice(0, separator);
  const id = value.slice(separator + 1);
  const principal = { type, id };
  return isWhiteboardGrantPrincipal(principal) ? principal : null;
}
