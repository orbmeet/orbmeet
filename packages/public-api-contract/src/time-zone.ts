// Plain time-zone helpers, free of any schema library so browser code can use
// them without pulling one in. `timeZoneSchema` in `fields.ts` builds on them.

export const MAX_TIME_ZONE_LENGTH = 100;

/** Whether the runtime recognises `value` as an IANA zone. */
export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}
