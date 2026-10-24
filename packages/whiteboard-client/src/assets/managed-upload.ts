export interface ManagedWhiteboardUpload {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/**
 * Make uploaded bytes durable before publishing a record that references them.
 *
 * Collaborative document writes can reach another browser immediately. If the
 * record is created first and this tab closes before commit finishes, peers
 * can retain a cached image while every fresh client inherits a dangling asset
 * URL. Keeping the publish callback behind commit makes that state impossible.
 */
export async function commitUploadBeforePublish<T>(
  upload: ManagedWhiteboardUpload | null,
  publish: () => T,
): Promise<T> {
  if (!upload) return publish();

  try {
    await upload.commit();
  } catch (error) {
    await upload.rollback().catch(() => {});
    throw error;
  }

  // Do not roll a committed upload back if the local publish fails. A commit
  // can already be visible to immutable revision capture, and rollback after
  // that boundary would turn a local editor error into a broken saved board.
  return publish();
}
