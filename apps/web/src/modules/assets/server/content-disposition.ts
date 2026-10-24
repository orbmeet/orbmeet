/** Build an attachment header value safe for both quoted ASCII and RFC 5987. */
export function buildAttachmentContentDisposition(filename: string): string {
  const ascii = filename
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\]/g, "_") || "download";
  // encodeURIComponent leaves `'()*` intact, but none are RFC 5987 attr-chars,
  // so a filename containing them would otherwise produce an invalid ext-value.
  const utf8 = encodeURIComponent(filename || "download")
    .replace(/['()*]/g, (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}
