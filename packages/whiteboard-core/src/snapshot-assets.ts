import {
  extractWhiteboardAssetKeyFromViewerUrl,
  extractWhiteboardDocumentAssetIdentity,
} from "./whiteboard-asset-key.ts";

/**
 * The asset objects a snapshot's `asset` records point at, sorted and
 * de-duplicated. Only `asset` records count: a key that merely appears in
 * shape text or metadata is not a reference.
 *
 * The sync server reports this with every snapshot it stores, so the Worker
 * can pin and authorize a revision's assets without reading its bytes.
 */
export function extractSnapshotAssetKeys(snapshot: unknown): string[] {
  const root = snapshot;
  if (!root || typeof root !== "object" || !Array.isArray((root as { documents?: unknown }).documents)) {
    return [];
  }

  const keys = new Set<string>();
  for (const entry of (root as { documents: unknown[] }).documents) {
    if (!entry || typeof entry !== "object") continue;
    const state = (entry as { state?: unknown }).state;
    if (!state || typeof state !== "object") continue;
    const record = state as { typeName?: unknown; props?: unknown };
    if (record.typeName !== "asset" || !record.props || typeof record.props !== "object") continue;
    const src = (record.props as { src?: unknown }).src;
    if (typeof src !== "string") continue;
    const key = extractWhiteboardAssetKeyFromViewerUrl(src) ?? src;
    if (extractWhiteboardDocumentAssetIdentity(key)) keys.add(key);
  }

  return [...keys].sort();
}
