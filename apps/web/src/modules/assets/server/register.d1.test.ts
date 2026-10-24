import { beforeEach, describe, expect, it } from "vitest";
import {
  meetingLinks,
  meetings,
  spaces,
  uploadReservations,
  users,
} from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";
import {
  commitReservedFileMetadata,
  registerMeetingArtifactMetadata,
  replaceMeetingWhiteboardPdfMetadata,
} from "./register";
import { reserveUploadBytes } from "./upload-reservations";

let db: TestDb;
const appDb = () => db;

beforeEach(async () => {
  db = await createTestDb();
  const now = new Date();
  await db.insert(users).values({
    id: "owner",
    name: "Owner",
    email: "owner@example.com",
    normalizedEmail: "owner@example.com",
    plan: "free",
    role: "user",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(spaces).values({
    kind: "shared",
    id: "space_1",
    slug: "space_1-slug",
    name: "Space",
    ownerUserId: "owner",
    createdAt: now,
    updatedAt: now,
  });
});

describe("commitReservedFileMetadata", () => {
  it("atomically consumes an exact reservation when it registers the asset", async () => {
    await reserveUploadBytes(appDb(), {
      id: "asset_reserved",
      principal: { type: "user", id: "owner" },
      scope: "space-pdf:space_1",
      bytes: 100,
      limitBytes: 1_000,
    });

    await commitReservedFileMetadata(appDb(), {
      id: "asset_reserved",
      spaceId: "space_1",
      type: "pdf",
      r2Key: "spaces/space_1/uploads/asset_reserved.pdf",
      filename: "reserved.pdf",
      mimeType: "application/pdf",
      size: 100,
      uploadedByUserId: "owner",
      reservationPrincipal: "user:owner",
      reservationScope: "space-pdf:space_1",
    });

    await expect(db.query.files.findFirst({
      where: { id: "asset_reserved" },
    })).resolves.toMatchObject({ size: 100 });
    await expect(db.select().from(uploadReservations)).resolves.toEqual([]);
  });

  it("rejects an object whose actual size differs from the reservation", async () => {
    await reserveUploadBytes(appDb(), {
      id: "asset_wrong_size",
      principal: { type: "user", id: "owner" },
      scope: "space-pdf:space_1",
      bytes: 100,
      limitBytes: 1_000,
    });

    await expect(commitReservedFileMetadata(appDb(), {
      id: "asset_wrong_size",
      spaceId: "space_1",
      type: "pdf",
      r2Key: "spaces/space_1/uploads/asset_wrong_size.pdf",
      filename: "wrong-size.pdf",
      mimeType: "application/pdf",
      size: 101,
      uploadedByUserId: "owner",
      reservationPrincipal: "user:owner",
      reservationScope: "space-pdf:space_1",
    })).rejects.toThrow("Failed to commit reserved asset");

    await expect(db.query.files.findFirst({
      where: { id: "asset_wrong_size" },
    })).resolves.toBeUndefined();
    await expect(db.query.uploadReservations.findFirst({
      where: { id: "asset_wrong_size" },
    })).resolves.toBeDefined();
  });
});

describe("registerMeetingArtifactMetadata", () => {
  it("derives meeting artifact space from the meeting", async () => {
    const now = new Date();
    await db.insert(meetingLinks).values({
      id: "room_artifact_register",
      code: "ijk-lmno-pqr",
      spaceId: "space_1",
spaceKind: "shared" as const,
      title: "Artifact Meeting",
      allowGuests: false,
      joinPolicy: "open",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(meetings).values({
      id: "mtg_artifact_register",
      meetingLinkId: "room_artifact_register",
      title: "Artifact Meeting",
      startedByUserId: "owner",
      spaceId: "space_1",
    spaceKind: "shared" as const,
      status: "open",
    billingPrincipalType: "user" as const,
    billingPrincipalId: "owner",
    billingPlan: "free",
      allowGuests: false,
      recordingEnabled: false,
      joinPolicy: "open",
      activeEgressId: null,
      startedAt: now,
      endedAt: null,
      retainUntil: null,
      updatedAt: now,
    });

    // The combined handout belongs to the Meeting; its Space still comes from
    // the authoritative Meeting row.
    const exportKey = "meetings/mtg_artifact_register/exports/whiteboard.pdf";
    await registerMeetingArtifactMetadata(appDb(), {
      meetingId: "mtg_artifact_register",
      type: "whiteboard_pdf",
      r2Key: exportKey,
      filename: "meeting-artifact.pdf",
      mimeType: "application/pdf",
      size: 100,
      uploadedByUserId: "owner",
      overwriteOnConflict: false,
    });

    await expect(
      db.query.meetingArtifacts.findFirst({
        where: { r2Key: exportKey },
        columns: { spaceId: true },
      }),
    ).resolves.toMatchObject({ spaceId: "space_1" });

    const replacementKey = "meetings/mtg_artifact_register/exports/whiteboard/publish-2.pdf";
    await expect(replaceMeetingWhiteboardPdfMetadata(appDb(), {
      meetingId: "mtg_artifact_register",
      type: "whiteboard_pdf",
      r2Key: replacementKey,
      filename: "replacement.pdf",
      mimeType: "application/pdf",
      size: 200,
      uploadedByUserId: "owner",
    })).resolves.toBe(exportKey);
    await expect(db.query.meetingArtifacts.findMany({
      where: { meetingId: "mtg_artifact_register", type: "whiteboard_pdf" },
      columns: { r2Key: true, size: true },
    })).resolves.toEqual([{ r2Key: replacementKey, size: 200 }]);
  });

  it("rejects metadata for a missing meeting", async () => {
    await expect(
      registerMeetingArtifactMetadata(appDb(), {
        meetingId: "mtg_missing",
        type: "whiteboard_pdf",
        r2Key: "meetings/mtg_missing/exports/whiteboard.pdf",
        filename: "missing-meeting.pdf",
        mimeType: "application/pdf",
        size: 100,
        uploadedByUserId: "owner",
        overwriteOnConflict: false,
      }),
    ).rejects.toThrow("Failed to register meeting artifact metadata");
  });

  it("rejects a key belonging to another Meeting before writing", async () => {
    await expect(
      registerMeetingArtifactMetadata(appDb(), {
        meetingId: "mtg_expected",
        type: "whiteboard_pdf",
        r2Key: "meetings/mtg_other/exports/whiteboard.pdf",
        filename: "export.pdf",
        mimeType: "application/pdf",
        size: 100,
        uploadedByUserId: "owner",
        overwriteOnConflict: false,
      }),
    ).rejects.toThrow("does not match type");
  });
});
