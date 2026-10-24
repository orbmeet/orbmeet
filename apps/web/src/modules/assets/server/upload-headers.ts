export function buildPresignedUploadHeaders(input: {
  mimeType: string;
  fileSize: number;
  md5Hash?: string;
}): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": input.mimeType,
    "Content-Length": String(input.fileSize),
  };

  if (input.md5Hash) {
    if (!/^[0-9a-f]{32}$/i.test(input.md5Hash)) {
      throw new TypeError("md5Hash must be a 32-character hexadecimal digest");
    }
    headers["Content-MD5"] = btoa(
      input.md5Hash
        .match(/.{2}/g)!
        .map((byte) => String.fromCharCode(parseInt(byte, 16)))
        .join(""),
    );
  }

  return headers;
}
