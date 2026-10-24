/** The longest name a meeting is given on its behalf. */
const MAX_GENERATED_TITLE_LENGTH = 80;

/**
 * A model's proposed name, made fit to show: one line, no wrapping quotes or
 * closing full stop, within the length a row can hold. Null when nothing
 * usable is left.
 */
export function cleanGeneratedTitle(raw: string): string | null {
  const title = raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["“”'‘’]+|["“”'‘’]+$/g, "")
    .replace(/[.。]+$/, "")
    .trim();
  if (title.length < 3) return null;
  return title.length > MAX_GENERATED_TITLE_LENGTH
    ? `${title.slice(0, MAX_GENERATED_TITLE_LENGTH - 1).trimEnd()}…`
    : title;
}
