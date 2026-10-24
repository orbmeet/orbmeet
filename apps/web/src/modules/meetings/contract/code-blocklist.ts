/**
 * Substrings a meeting code must never contain.
 *
 * A code is ten random letters shown as `abc-defg-hij`, and it travels in
 * calendar invitations, chat messages and email. Left unfiltered, a three-letter
 * slur lands in one of the eight windows across those ten letters with
 * probability ~8/26³ each — across a list this size that is roughly one code in
 * a hundred, so at any real volume the product *will* mint offensive links and
 * put them in front of people. Every mainstream meeting product filters for
 * exactly this reason.
 *
 * Scope and limits, stated plainly: this is an English-language, substring-level
 * filter over `a-z`. It is not a general profanity classifier and is not meant
 * to be — its whole job is to stop the small set of short tokens that random
 * generation can realistically produce. Entries must be lowercase `a-z` only;
 * anything else can never match a code and would be dead weight.
 *
 * False positives are free (the generator simply rolls again, and a Pro user
 * picking a custom code can pick another), so prefer including a borderline
 * token over omitting it.
 */
const MEETING_CODE_BLOCKED_SUBSTRINGS = [
  // Sexual / vulgar
  "anal", "anus", "arse", "ass", "boob", "clit", "cock", "cok", "cum", "cunt",
  "dick", "dik", "dildo", "fuc", "fuck", "fuk", "hoe", "jizz", "porn", "puss",
  "sex", "slut", "smut", "tit", "twat", "wank", "whore",
  // Scatological
  "crap", "fart", "piss", "poop", "shit", "turd",
  // Slurs and hate terms
  "chink", "coon", "dago", "fag", "gook", "gyp", "kike", "kkk", "nig", "paki",
  "spic", "wop", "nazi",
  // Violence
  "rape", "kill",
] as const;

/**
 * True when a candidate code contains a blocked substring.
 *
 * Hyphens are stripped first, so the check also catches a token that straddles
 * a group boundary (`ass` in `xxa-ssxx-yyy`). The separators are formatting,
 * not part of the credential, and a reader sees the letters either way.
 */
export function containsBlockedMeetingCodeTerm(code: string): boolean {
  const letters = code.toLowerCase().replace(/-/g, "");
  return MEETING_CODE_BLOCKED_SUBSTRINGS.some((term) => letters.includes(term));
}
