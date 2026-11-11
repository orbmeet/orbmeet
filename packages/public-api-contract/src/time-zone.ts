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

/**
 * Zones V8 still names as IANA no longer does. V8 (Chrome, Edge, Node,
 * Workers) takes its names from CLDR, which keeps an identifier once issued,
 * so India is `Asia/Calcutta` there and `Asia/Kolkata` in Firefox and Safari.
 * Each pair is one zone under two spellings, and V8 accepts both.
 *
 * Every link in tzdata's `backward` file whose name V8 lists and whose target
 * it does not, less `Indian/Cocos`: tzdata merged its rules into
 * Asia/Yangon's, but it is a different place, not a renamed one.
 */
const CURRENT_TIME_ZONE_NAMES: Readonly<Record<string, string>> = {
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "America/Catamarca": "America/Argentina/Catamarca",
  "America/Cordoba": "America/Argentina/Cordoba",
  "America/Godthab": "America/Nuuk",
  "America/Indianapolis": "America/Indiana/Indianapolis",
  "America/Jujuy": "America/Argentina/Jujuy",
  "America/Louisville": "America/Kentucky/Louisville",
  "America/Mendoza": "America/Argentina/Mendoza",
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Europe/Kiev": "Europe/Kyiv",
  "Pacific/Enderbury": "Pacific/Kanton",
};

/** `zone` under its current IANA name, whichever spelling the runtime reported. */
export function currentTimeZoneName(zone: string): string {
  return Object.hasOwn(CURRENT_TIME_ZONE_NAMES, zone) ? CURRENT_TIME_ZONE_NAMES[zone] : zone;
}
