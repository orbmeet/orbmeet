/** Where a meeting's board preview is read and published, by meeting id. */
export const MEETING_PREVIEW_PATH = "/api/whiteboard/meeting-preview/";

export function meetingPreviewUrl(meetingId: string): string {
  return `${MEETING_PREVIEW_PATH}${encodeURIComponent(meetingId)}`;
}

/**
 * The image type these bytes really are, or null for anything else: what is
 * stored is shown to everyone who can open the meeting, so the claim a request
 * makes about itself is not enough.
 */
export function sniffPreviewImageType(bytes: Uint8Array): "image/webp" | "image/png" | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= png.length && png.every((byte, index) => bytes[index] === byte)) return "image/png";
  return null;
}
