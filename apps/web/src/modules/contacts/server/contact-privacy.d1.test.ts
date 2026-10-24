import { beforeEach, describe, expect, it } from "vitest";
import {
  meetingAdmissions,
  meetingConnections,
  meetingLinks,
  meetings,
  users,
} from "@orbmeet/db/schema";

import { createTestDb, type TestDb } from "@/test/db";
import { indexMeetingContacts, seedPersonalSpace } from "@/test/fixtures";
import {
  rememberInvitedContacts,
  resolveOwnedContactSeeds,
  searchAutomationTargets,
} from "@/modules/contacts/server/contact-index";

let db: TestDb;
const createdAt = new Date("2026-07-14T08:00:00.000Z");

async function insertUser(id: string, name: string, email: string) {
  await db.insert(users).values({
    id,
    name,
    email,
    normalizedEmail: email.toLowerCase(),
    image: null,
    plan: "pro",
    role: "user",
    createdAt,
    updatedAt: createdAt,
  });
}

const organizer = { id: "usr_owner", email: "atiq@example.com" };

beforeEach(async () => {
  db = await createTestDb();
  await insertUser("usr_owner", "Atiq", "atiq@example.com");
  await insertUser("usr_maruf", "Maruf Hasan", "maruf@example.com");
});

async function seedMeetingDerivedContact() {
  await seedPersonalSpace(db, "usr_owner");
  await db.insert(meetingLinks).values({
    id: "mln_leak",
    code: "con-tact-lek",
    reusePolicy: "one_time",
    spaceId: "usr_owner_space",
    spaceKind: "personal" as const,
    title: "Leak",
    allowGuests: true,
    joinPolicy: "open",
    createdAt,
    updatedAt: createdAt,
  });
  await db.insert(meetings).values({
    id: "mtg_leak",
    meetingLinkId: "mln_leak",
    spaceId: "usr_owner_space",
    spaceKind: "personal" as const,
    title: "Leak",
    startedByUserId: "usr_owner",
    status: "ended",
    billingPrincipalType: "user" as const,
    billingPrincipalId: "usr_owner",
    billingPlan: "free",
    allowGuests: true,
    recordingEnabled: false,
    joinPolicy: "open",
    startedAt: createdAt,
    endedAt: new Date(createdAt.getTime() + 30 * 60_000),
    retainUntil: new Date(createdAt.getTime() + 24 * 60 * 60_000),
    updatedAt: new Date(createdAt.getTime() + 30 * 60_000),
  });
  await db.insert(meetingAdmissions).values({
    id: "mad_leak_maruf",
    meetingId: "mtg_leak",
    subjectType: "user",
    subjectUserId: "usr_maruf",
    displayName: "usr_maruf",
    admissionStatus: "approved",
    decidedAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  });
  await db.insert(meetingConnections).values({
    id: "mcn_leak_maruf",
    meetingId: "mtg_leak",
    admissionId: "mad_leak_maruf",
    livekitIdentity: "identity_maruf",
    userId: "usr_maruf",
    role: "attendee",
    connectionStatus: "ended",
    tokenIssuedAt: createdAt,
    connectedAt: createdAt,
    disconnectedAt: new Date(createdAt.getTime() + 30 * 60_000),
    createdAt,
    updatedAt: new Date(createdAt.getTime() + 30 * 60_000),
  });
  await indexMeetingContacts(db, "mtg_leak");
}

describe("automation contact discovery privacy", () => {
  it("marks a resolved delivery address as private", async () => {
    await seedMeetingDerivedContact();
    const contact = await db.query.userContacts.findFirst({
      where: { ownerUserId: "usr_owner" },
    });
    expect(contact).toMatchObject({ contactUserId: "usr_maruf", email: null });

    const seeds = await resolveOwnedContactSeeds(db, "usr_owner", [contact!.id]);
    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toMatchObject({ email: "maruf@example.com", privateEmail: true });
  });

  it("remembering resolved contacts preserves opaque contact privacy", async () => {
    await seedMeetingDerivedContact();
    const contact = await db.query.userContacts.findFirst({
      where: { ownerUserId: "usr_owner" },
    });
    const seeds = await resolveOwnedContactSeeds(db, "usr_owner", [contact!.id]);

    await rememberInvitedContacts(
      db,
      organizer,
      seeds.map((seed) => ({
        email: seed.email,
        privateEmail: seed.privateEmail,
        displayName: seed.displayName,
        contactUserId: seed.contactUserId,
      })),
    );

    const upgraded = await db.query.userContacts.findFirst({
      where: { ownerUserId: "usr_owner" },
    });
    expect(upgraded?.email).toBeNull();
    expect(upgraded?.normalizedEmail).toBeNull();

    const search = await searchAutomationTargets(db, "usr_owner", "Maruf");
    expect(search.candidates[0]).toMatchObject({ type: "contact", name: "Maruf Hasan" });
    // The account address is never carried on a contact whose email is private.
    expect(search.candidates[0]).not.toHaveProperty("email");
    expect(await searchAutomationTargets(db, "usr_owner", "maruf@example.com"))
      .toMatchObject({ candidates: [] });
  });
});
