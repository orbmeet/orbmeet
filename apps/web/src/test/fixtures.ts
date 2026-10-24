import type { Database } from "@orbmeet/db";
import { indexMeetingContacts as runContactIndex } from "@/modules/contacts/server/contact-index";
import { immediateJobStep } from "./jobs";
import {
  meetingWhiteboards,
  meetingWhiteboardSurfaces,
  spaceMembers,
  spaces,
  whiteboards,
} from "@orbmeet/db/schema";

/**
 * Test fixtures for the unified-context model. Every account owns a personal
 * space; tests that seed users directly use these helpers to provision the
 * space (named owner, with an admin membership) the way signup does.
 */

export function personalSpaceIdFor(userId: string): string {
  return `${userId}_space`;
}

export async function seedPersonalSpace(
  db: Database,
  userId: string,
  options: { spaceId?: string; name?: string; now?: Date } = {},
): Promise<string> {
  const spaceId = options.spaceId ?? personalSpaceIdFor(userId);
  const now = options.now ?? new Date();
  await db
    .insert(spaces)
    .values({
      id: spaceId,
      kind: "personal",
      name: options.name ?? userId,
      ownerUserId: userId,
      organizationId: null,
      slug: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  await db
    .insert(spaceMembers)
    .values({
      id: `${spaceId}_owner`,
      spaceId,
      userId,
      role: "admin",
      joinedAt: now,
    })
    .onConflictDoNothing();
  return spaceId;
}

export async function seedSharedSpace(
  db: Database,
  options: {
    id: string;
    ownerUserId?: string | null;
    organizationId?: string | null;
    name?: string;
    slug?: string | null;
    now?: Date;
    members?: Array<{ userId: string; role?: "owner" | "admin" | "member" }>;
  },
): Promise<string> {
  const now = options.now ?? new Date();
  await db
    .insert(spaces)
    .values({
      id: options.id,
      kind: "shared",
      name: options.name ?? options.id,
      ownerUserId: options.organizationId ? null : options.ownerUserId ?? null,
      organizationId: options.organizationId ?? null,
      slug: options.slug === undefined ? options.id : options.slug,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  for (const member of options.members ?? []) {
    await db
      .insert(spaceMembers)
      .values({
        id: `${options.id}_${member.userId}`,
        spaceId: options.id,
        userId: member.userId,
        // An owner is named on the Space and stored as an admin member.
        role: member.role === "owner" ? "admin" : member.role ?? "member",
        joinedAt: now,
      })
      .onConflictDoNothing();
  }
  return options.id;
}

export async function seedMeetingWhiteboard(
  db: Database,
  options: {
    meetingId: string;
    spaceId: string;
    whiteboardId?: string;
    meetingWhiteboardId?: string;
    title?: string | null;
    createdByUserId?: string | null;
    surfaceOpen?: boolean;
    surfaceRevision?: number;
    /**
     * Whether this is the board the Meeting is looking at. A Meeting may
     * present many Whiteboards but focus at most one, which a partial unique
     * index enforces — so seeding a second presentation for the same Meeting
     * must pass `focused: false`.
     */
    focused?: boolean;
    lastSharedSnapshotR2Key?: string | null;
    lastSharedSnapshotHash?: string | null;
    lastSharedSnapshotSize?: number | null;
    lastSharedDocumentClock?: number | null;
    lastSharedAt?: Date | null;
    now?: Date;
  },
): Promise<{ whiteboardId: string; meetingWhiteboardId: string }> {
  const now = options.now ?? new Date();
  const whiteboardId = options.whiteboardId ?? `whiteboard_${options.meetingId}`;
  const meetingWhiteboardId = options.meetingWhiteboardId ?? `meeting_whiteboard_${options.meetingId}`;
  await db.insert(whiteboards).values({
    id: whiteboardId,
    syncRoomId: whiteboardId,
    spaceId: options.spaceId,
    title: options.title ?? "Meeting Whiteboard",
    status: "active",
    createdByUserId: options.createdByUserId ?? null,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(meetingWhiteboards).values({
    id: meetingWhiteboardId,
    meetingId: options.meetingId,
    spaceId: options.spaceId,
    whiteboardId,
    titleAtUse: options.title ?? "Meeting Whiteboard",
    captureStatus: "live",
    attachedAt: now,
    lastPresentedAt: now,
    focusedAt: options.focused === false ? null : now,
    lastSharedSnapshotR2Key: options.lastSharedSnapshotR2Key ?? null,
    lastSharedSnapshotHash: options.lastSharedSnapshotR2Key
      ? options.lastSharedSnapshotHash ?? "0".repeat(32)
      : null,
    lastSharedDocumentClock: options.lastSharedSnapshotR2Key
      ? options.lastSharedDocumentClock ?? null
      : null,
    lastSharedSnapshotSize: options.lastSharedSnapshotR2Key
      ? options.lastSharedSnapshotSize ?? 0
      : null,
    lastSharedAt: options.lastSharedSnapshotR2Key
      ? options.lastSharedAt ?? now
      : null,
  });
  if (options.surfaceOpen !== undefined || options.surfaceRevision !== undefined) {
    await db.insert(meetingWhiteboardSurfaces)
      .values({
        meetingId: options.meetingId,
        open: options.surfaceOpen ?? false,
        revision: options.surfaceRevision ?? 0,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: meetingWhiteboardSurfaces.meetingId,
        set: {
          open: options.surfaceOpen ?? false,
          revision: options.surfaceRevision ?? 0,
          updatedAt: now,
        },
      });
  }
  return { whiteboardId, meetingWhiteboardId };
}

/**
 * Index a Meeting's co-attendees as its contacts job does, as of the time the
 * Meeting ended.
 */
export async function indexMeetingContacts(db: Database, meetingId: string) {
  await runContactIndex(immediateJobStep(), db, meetingId);
}
