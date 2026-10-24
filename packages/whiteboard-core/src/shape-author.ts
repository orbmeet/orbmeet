/**
 * Who made a shape, kept in the shape's `meta` so it travels with the record
 * through sync, snapshots and copies.
 *
 * The client stamps it when it creates a shape, so its own label appears at
 * once. The room server is the authority: it stores a new shape with the
 * pushing session as its author, whatever the client claimed, and refuses any
 * later write that changes the value (room-record-authorizers.ts), so no
 * client can name someone else as an author or strip one off. The name is
 * copied in at creation so a label still reads correctly after its author has
 * left the room.
 */
export const SHAPE_AUTHOR_META_KEY = "createdBy";

/** Matches the room's bound on a session's display name. */
export const MAX_SHAPE_AUTHOR_NAME_LENGTH = 256;
const MAX_SHAPE_AUTHOR_ID_LENGTH = 256;

export interface ShapeAuthor {
  id: string;
  name: string;
}

type Meta = Readonly<Record<string, unknown>>;

/** The author recorded in `meta`, or null when there is none or it is malformed. */
export function readShapeAuthor(meta: unknown): ShapeAuthor | null {
  if (!meta || typeof meta !== "object") return null;
  const value = (meta as Meta)[SHAPE_AUTHOR_META_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { id, name } = value as { id?: unknown; name?: unknown };
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_SHAPE_AUTHOR_ID_LENGTH) return null;
  if (typeof name !== "string" || name.length > MAX_SHAPE_AUTHOR_NAME_LENGTH) return null;
  return { id, name };
}

/** Whether `meta` records exactly `author` (null: records none at all). */
export function hasShapeAuthor(meta: unknown, author: ShapeAuthor | null): boolean {
  const present = meta && typeof meta === "object" && SHAPE_AUTHOR_META_KEY in (meta as Meta);
  if (!author) return !present;
  const value = present ? (meta as Meta)[SHAPE_AUTHOR_META_KEY] : null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  // Exact shape, not just matching fields: extra keys would ride along unchecked.
  const keys = Object.keys(value);
  const { id, name } = value as { id?: unknown; name?: unknown };
  return keys.length === 2 && id === author.id && name === author.name;
}

/** `meta` with its author set to `author`, or removed when `author` is null. */
export function withShapeAuthor<M extends Meta>(meta: M, author: ShapeAuthor | null): M {
  const { [SHAPE_AUTHOR_META_KEY]: _previous, ...rest } = meta;
  return (author ? { ...rest, [SHAPE_AUTHOR_META_KEY]: { id: author.id, name: author.name } } : rest) as unknown as M;
}

/** A session's identity as an author, with the name bounded like the room bounds it. */
export function shapeAuthorOf(userId: string, userName: string): ShapeAuthor {
  return { id: userId, name: userName.slice(0, MAX_SHAPE_AUTHOR_NAME_LENGTH) };
}
