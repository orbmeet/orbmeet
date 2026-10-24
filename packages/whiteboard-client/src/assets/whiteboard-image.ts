export const WHITEBOARD_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export const WHITEBOARD_SUPPORTED_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export const WHITEBOARD_IMAGE_ACCEPT_ATTR =
  WHITEBOARD_SUPPORTED_IMAGE_MIME_TYPES.join(",");

const WHITEBOARD_IMAGE_URL_EXTENSION_RE =
  /\.(png|jpe?g|gif|webp)(?:$|[?#])/i;

const WHITEBOARD_IMAGE_FILE_EXTENSION_RE =
  /\.(png|jpe?g|gif|webp)$/i;

export type WhiteboardSupportedImageMimeType =
  (typeof WHITEBOARD_SUPPORTED_IMAGE_MIME_TYPES)[number];

export function isSupportedWhiteboardImageMimeType(
  mimeType: string
): mimeType is WhiteboardSupportedImageMimeType {
  return (
    WHITEBOARD_SUPPORTED_IMAGE_MIME_TYPES as readonly string[]
  ).includes(mimeType);
}

export function isSupportedWhiteboardImageFileName(filename: string): boolean {
  return WHITEBOARD_IMAGE_FILE_EXTENSION_RE.test(filename);
}

export function looksLikeWhiteboardImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return false;
    }
    return WHITEBOARD_IMAGE_URL_EXTENSION_RE.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function inferWhiteboardImageMimeTypeFromFileName(
  filename: string
): WhiteboardSupportedImageMimeType | null {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return null;
  }
}

// Broader regex matching image-like extensions that we DON'T support (for user error messages)
const IMAGE_LIKE_EXTENSION_RE =
  /\.(png|jpe?g|gif|webp|svg|bmp|tiff?|heic|avif)$/i;

/**
 * Partition a list of files into supported whiteboard images and
 * unsupported-but-image-like files, for both the paste and drop handlers.
 */
export function filterSupportedImageFiles(files: File[]): {
  supported: File[];
  unsupportedImages: File[];
} {
  const supported: File[] = [];
  const unsupportedImages: File[] = [];

  for (const file of files) {
    if (
      isSupportedWhiteboardImageMimeType(file.type) ||
      isSupportedWhiteboardImageFileName(file.name)
    ) {
      supported.push(file);
    } else if (
      file.type.startsWith("image/") ||
      IMAGE_LIKE_EXTENSION_RE.test(file.name)
    ) {
      unsupportedImages.push(file);
    }
  }

  return { supported, unsupportedImages };
}
