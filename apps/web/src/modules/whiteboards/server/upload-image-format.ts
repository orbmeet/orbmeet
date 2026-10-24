const ASCII = new TextEncoder();

function startsWith(bytes: Uint8Array, signature: Uint8Array | readonly number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

export function isWhiteboardImageHeader(mimeType: string, bytes: Uint8Array): boolean {
  switch (mimeType) {
    case "image/png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case "image/gif": {
      const header = new TextDecoder().decode(bytes.slice(0, 6));
      return header === "GIF87a" || header === "GIF89a";
    }
    case "image/webp":
      return startsWith(bytes, ASCII.encode("RIFF")) &&
        startsWith(bytes.slice(8), ASCII.encode("WEBP"));
    default:
      return false;
  }
}

export function whiteboardImageHeaderValidation(mimeType: string) {
  return {
    length: 12,
    validate: (bytes: Uint8Array) => isWhiteboardImageHeader(mimeType, bytes),
  };
}
