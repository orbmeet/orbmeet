import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  files,
  meetingArtifacts,
  meetingLinks,
  meetings,
  organizations,
  spaces,
  uploadReservations,
  users,
} from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";
import { seedPersonalSpace } from "@/test/fixtures";
import { getPrincipalStoredBytes, getUserStoredBytes } from "./storage";
import { reserveUploadBytes } from "./upload-reservations";

let db: TestDb;
const appDb = () => db;

beforeEach(async () => {
  db = await createTestDb();
  const now = new Date();
  await db.insert(users).values([
    {
      id: "billing_owner",
      name: "Billing owner",
      email: "billing@example.com",
      normalizedEmail: "billing@example.com",
      plan: "pro",
      role: "user",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "starter",
      name: "Starter",
      email: "starter@example.com",
      normalizedEmail: "starter@example.com",
      plan: "free",
      role: "user",
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await seedPersonalSpace(db, "starter");
  await db.insert(meetingLinks).values({
    id: "link_storage",
    code: "sto-rage-tst",
    spaceId: "starter_space",
spaceKind: "personal" as const,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(meetings).values({
    id: "meeting_storage",
    meetingLinkId: "link_storage",
    spaceId: "starter_space",
    spaceKind: "personal" as const,
    startedByUserId: "starter",
    billingPrincipalType: "user" as const,
    billingPrincipalId: "billing_owner",
    billingPlan: "pro",
    status: "open",
    startedAt: now,
    updatedAt: now,
  });
  await db.insert(meetingArtifacts).values({
    id: "artifact_storage",
    meetingId: "meeting_storage",
    spaceId: "starter_space",
    type: "recording",
    r2Key: "meetings/meeting_storage/recordings/eg_storage.mp4",
    filename: "meeting-storage.mp4",
    mimeType: "video/mp4",
    size: 400,
    uploadedByUserId: "starter",
    createdAt: now,
  });
});

describe("Meeting storage accounting", () => {
  it("charges the Meeting billing principal independently of uploader provenance", async () => {
    await expect(getUserStoredBytes(appDb(), "billing_owner")).resolves.toBe(400);
    await expect(getUserStoredBytes(appDb(), "starter")).resolves.toBe(0);
  });

  it("charges an organization snapshot to the Organization, not its current owner", async () => {
    const now = new Date();
    await db.insert(organizations).values({
      id: "organization_1",
      name: "Organization",
      ownerId: "billing_owner",
      plan: "organization",
      createdAt: now,
      updatedAt: now,
    });
    await db
      .update(meetings)
      .set({
        billingPrincipalType: "organization",
        billingPrincipalId: "organization_1",
        billingPlan: "organization",
      })
      .where(eq(meetings.id, "meeting_storage"));

    await expect(getPrincipalStoredBytes(appDb(), {
      type: "organization",
      id: "organization_1",
    })).resolves.toBe(400);
    await expect(getUserStoredBytes(appDb(), "billing_owner")).resolves.toBe(0);
    await expect(getUserStoredBytes(appDb(), "starter")).resolves.toBe(0);
  });

  it("does not move a deleted Organization's usage onto its uploader", async () => {
    await db
      .update(meetings)
      .set({
        billingPrincipalType: "organization",
        billingPrincipalId: "deleted_organization",
        billingPlan: "organization",
      })
      .where(eq(meetings.id, "meeting_storage"));

    await expect(getUserStoredBytes(appDb(), "starter")).resolves.toBe(0);
    await expect(getUserStoredBytes(appDb(), "billing_owner")).resolves.toBe(0);
  });
});

describe("file storage accounting", () => {
  it("counts only committed files, not in-flight pending uploads", async () => {
    const now = new Date();
    await db.insert(files).values({
      id: "file_committed",
      spaceId: "starter_space",
      type: "pdf",
      status: "committed",
      r2Key: "spaces/starter_space/uploads/file_committed.pdf",
      filename: "committed.pdf",
      mimeType: "application/pdf",
      size: 100,
      uploadedByUserId: "starter",
      committedAt: now,
      createdAt: now,
    });
    await db.insert(files).values({
      id: "file_pending",
      spaceId: "starter_space",
      type: "pdf",
      status: "pending",
      r2Key: "spaces/starter_space/uploads/file_pending.pdf",
      filename: "pending.pdf",
      mimeType: "application/pdf",
      size: 250,
      uploadedByUserId: "starter",
      expiresAt: new Date(now.getTime() + 15 * 60 * 1000),
      committedAt: null,
      createdAt: now,
    });

    // A pending file's bytes are already held by an upload reservation.
    // Counting them as committed usage here too would double-charge the quota
    // during the upload window, so only committed files are included.
    await expect(getUserStoredBytes(appDb(), "starter")).resolves.toBe(100);
  });

  it("charges files to the owning Organization Space regardless of uploader", async () => {
    const now = new Date();
    await db.insert(organizations).values({
      id: "organization_files",
      name: "Organization files",
      ownerId: "billing_owner",
      plan: "organization",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(spaces).values({
      id: "organization_space",
      slug: "organization-space",
      name: "Organization Space",
      kind: "shared",
      ownerUserId: null,
      organizationId: "organization_files",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(files).values({
      id: "organization_file",
      spaceId: "organization_space",
      type: "pdf",
      status: "committed",
      r2Key: "spaces/organization_space/uploads/organization_file.pdf",
      filename: "organization-file.pdf",
      mimeType: "application/pdf",
      size: 250,
      uploadedByUserId: "starter",
      committedAt: now,
      createdAt: now,
    });

    await expect(getPrincipalStoredBytes(appDb(), {
      type: "organization",
      id: "organization_files",
    })).resolves.toBe(250);
    await expect(getUserStoredBytes(appDb(), "starter")).resolves.toBe(0);
  });
});

describe("upload quota reservations", () => {
  it("atomically admits only reservations that fit with committed usage", async () => {
    const results = await Promise.allSettled([
      reserveUploadBytes(appDb(), {
        id: "upload-a",
        principal: { type: "user", id: "billing_owner" },
        scope: "space-pdf:space-a",
        bytes: 300,
        limitBytes: 800,
      }),
      reserveUploadBytes(appDb(), {
        id: "upload-b",
        principal: { type: "user", id: "billing_owner" },
        scope: "space-pdf:space-a",
        bytes: 300,
        limitBytes: 800,
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(db.select().from(uploadReservations)).resolves.toHaveLength(1);
  });

  it("does not let a conflicting id replace another principal's reservation", async () => {
    await reserveUploadBytes(appDb(), {
      id: "shared-id",
      principal: { type: "user", id: "billing_owner" },
      scope: "space-pdf:space-a",
      bytes: 100,
      limitBytes: null,
    });

    await expect(reserveUploadBytes(appDb(), {
      id: "shared-id",
      principal: { type: "user", id: "starter" },
      scope: "space-pdf:space-b",
      bytes: 200,
      limitBytes: null,
    })).rejects.toThrow("upload_quota_exceeded");

    await expect(db.query.uploadReservations.findFirst({
      where: { id: "shared-id" },
    })).resolves.toMatchObject({
      principal: "user:billing_owner",
      scope: "space-pdf:space-a",
      bytes: 100,
    });
  });
});
