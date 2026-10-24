export interface ConnectedWhiteboardUser {
  userId: string;
  userName: string;
  /** Their grant principal: what giving them edit access names. Absent from an older room. */
  principalKey?: string;
  /** Whether they can write on the board already. Absent from an older room. */
  canEdit?: boolean;
}

const MAX_IDENTITY_LENGTH = 256;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function isDisplayString(value: unknown, allowEmpty: boolean): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    value.length <= MAX_IDENTITY_LENGTH &&
    !CONTROL_CHARACTERS.test(value)
  );
}

/** Decode the untrusted manager-only roster projection into a UI-safe shape. */
export function normalizeConnectedWhiteboardUsers(value: unknown): ConnectedWhiteboardUser[] {
  if (!Array.isArray(value)) return [];

  const result: ConnectedWhiteboardUser[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const { userId, userName, principalKey, canEdit } = entry as Record<string, unknown>;
    if (!isDisplayString(userId, false) || !isDisplayString(userName, true)) continue;
    if (seen.has(userId)) continue;
    seen.add(userId);
    result.push({
      userId,
      userName,
      ...(isDisplayString(principalKey, false) ? { principalKey } : {}),
      ...(typeof canEdit === "boolean" ? { canEdit } : {}),
    });
  }
  return result;
}
