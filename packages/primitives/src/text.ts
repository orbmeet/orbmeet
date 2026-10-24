/**
 * The largest index no greater than `index` that does not fall between the
 * two halves of a UTF-16 surrogate pair: where `text` can be cut without
 * leaving half a character on either side.
 */
export function codePointBoundary(text: string, index: number): number {
  if (index <= 0) return 0;
  if (index >= text.length) return text.length;
  const before = text.charCodeAt(index - 1);
  const after = text.charCodeAt(index);
  const splitsPair = before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
  return splitsPair ? index - 1 : index;
}

/** `text` cut to at most `maxLength` UTF-16 code units, never through a character. */
export function truncateCodeUnits(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : text.slice(0, codePointBoundary(text, maxLength));
}

const utf8 = new TextEncoder();

/** `text` cut to at most `maxBytes` bytes of UTF-8, never through a character. */
export function truncateUtf8(text: string, maxBytes: number): string {
  // `encodeInto` writes whole characters only, and says how much of `text` it took.
  const { read } = utf8.encodeInto(text, new Uint8Array(Math.max(0, maxBytes)));
  return read === text.length ? text : text.slice(0, read);
}
