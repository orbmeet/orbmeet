/**
 * Sanitize a display name for safe rendering.
 * Strips HTML tags, control characters, normalizes whitespace.
 */
export function sanitizeDisplayName(
  raw: string,
  fallback = "Guest"
): string {
  const sanitized = raw
    .replace(/<[^>]*>/g, "") // Strip HTML tags
    .replace(/[\x00-\x1F\x7F\u00AD\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, "") // Strip control + bidi/invisible format chars
    .replace(/\s+/g, " ") // Normalize whitespace
    .trim();
  // Truncate Unicode code points without materializing another full-size array.
  let truncated = "";
  let codePoints = 0;
  for (const character of sanitized) {
    if (codePoints === 100) break;
    truncated += character;
    codePoints += 1;
  }
  return truncated || fallback;
}
