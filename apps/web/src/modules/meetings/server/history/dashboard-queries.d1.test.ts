import { beforeEach, describe, expect, it } from "vitest";
import { meetingLinks, users } from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";
import { seedPersonalSpace } from "@/test/fixtures";
import { selectDashboardMeetingLinks } from "./dashboard-queries";

let db: TestDb;
const getAppDb = () => db;

beforeEach(async () => {
  db = await createTestDb();
});

async function insertUser(id: string, plan: "free" | "pro" | "organization") {
  const now = new Date();
  await db.insert(users).values({
    id,
    name: id,
    email: `${id}@example.com`,
    normalizedEmail: `${id}@example.com`,
    image: null,
    plan,
    role: "user",
    createdAt: now,
    updatedAt: now,
  });
}

async function insertMeetingLink(ownerUserId: string, code: string) {
  const now = new Date();
  await seedPersonalSpace(db, ownerUserId);
  await db.insert(meetingLinks).values({
    id: `room_${ownerUserId}`,
    code,
    reusePolicy: "reusable",
    spaceId: `${ownerUserId}_space`,
    spaceKind: "personal" as const,
    title: "Personal link",
    allowGuests: true,
    lastUsedAt: now,
    createdAt: now,
    updatedAt: now,
  });
}

describe("dashboard queries", () => {
  it("lists no links for an account that has not created anything yet", async () => {
    await insertUser("new_user", "free");

    await expect(
      selectDashboardMeetingLinks(getAppDb(), { id: "new_user", plan: "free" }),
    ).resolves.toEqual({ links: [] });
  });

  it("keeps the Free plan's permanent personal meeting link active", async () => {
    await insertUser("free_user", "free");
    await insertUser("pro_user", "pro");
    await insertMeetingLink("free_user", "abc-defg-hij");
    await insertMeetingLink("pro_user", "klm-nopq-rst");

    await expect(
      selectDashboardMeetingLinks(getAppDb(), { id: "free_user", plan: "free" }),
    ).resolves.toMatchObject({
      links: [{ code: "abc-defg-hij" }],
    });

    await expect(
      selectDashboardMeetingLinks(getAppDb(), { id: "pro_user", plan: "pro" }),
    ).resolves.toMatchObject({
      links: [{ code: "klm-nopq-rst" }],
    });
  });
});
