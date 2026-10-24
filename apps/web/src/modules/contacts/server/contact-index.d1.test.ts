import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  meetingAdmissions,
  meetingConnections,
  meetingLinks,
  meetings,
  spaceMembers,
  spaces,
  userContacts,
  users,
} from "@orbmeet/db/schema";

import { createTestDb, type TestDb } from "@/test/db";
import { indexMeetingContacts, seedPersonalSpace, seedSharedSpace } from "@/test/fixtures";
import {
  SPACE_RESOLUTION_CANDIDATE_CAP,
  rememberInvitedContacts,
  resolveAutomationContactNames,
  resolveAutomationSpaceName,
  searchAutomationTargets,
} from "./contact-index";

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

beforeEach(async () => {
  db = await createTestDb();
  await insertUser("usr_owner", "Atiq", "atiq@example.com");
  await insertUser("usr_maruf", "Maruf Hasan", "maruf@example.com");
  await insertUser("usr_other_maruf", "Maruf Rahman", "rahman@example.com");
});

describe("contact index", () => {
  it("resolves registered invitees and retains guest email contacts", async () => {
    await rememberInvitedContacts(
      db,
      { id: "usr_owner", email: "atiq@example.com" },
      [{ email: "MARUF@example.com" }, { email: "outside@example.com", displayName: "Outside Guest" }],
      createdAt,
    );

    await expect(db.query.userContacts.findFirst({ where: { normalizedEmail: "maruf@example.com" } })).resolves.toMatchObject({
      ownerUserId: "usr_owner",
      contactUserId: "usr_maruf",
      displayName: "Maruf Hasan",
      source: "invitation",
      meetingCount: 0,
    });
    await expect(db.query.userContacts.findFirst({ where: { normalizedEmail: "outside@example.com" } })).resolves.toMatchObject({
      contactUserId: null,
      displayName: "Outside Guest",
    });
  });

  it("stores a long unregistered email as a bounded display name", async () => {
    // The display name falls back to the raw address, and `display_name` is
    // capped at 100 characters — so a valid longer address failed the whole
    // contact batch on a CHECK constraint instead of storing a shorter label.
    const longEmail = `${"a".repeat(120)}@example.com`;
    await rememberInvitedContacts(
      db,
      { id: "usr_owner", email: "atiq@example.com" },
      [{ email: longEmail }, { email: "second@example.com", displayName: "Second" }],
      createdAt,
    );

    const contact = await db.query.userContacts.findFirst({
      where: { normalizedEmail: longEmail },
    });
    expect(contact?.email).toBe(longEmail);
    expect(contact?.displayName).toBe("a".repeat(100));
    // The rest of the batch is written rather than rolled back with it.
    await expect(
      db.query.userContacts.findFirst({ where: { normalizedEmail: "second@example.com" } }),
    ).resolves.toMatchObject({ displayName: "Second" });
  });

  it("searches contact names with non-ASCII case folding", async () => {
    await rememberInvitedContacts(
      db,
      { id: "usr_owner", email: "atiq@example.com" },
      [{ email: "ecole@example.com", displayName: "École" }],
      createdAt,
    );
    await expect(searchAutomationTargets(db, "usr_owner", "école"))
      .resolves.toMatchObject({ candidates: [{ type: "contact", name: "École" }] });
    await expect(resolveAutomationContactNames(db, "usr_owner", ["école"]))
      .resolves.toHaveLength(1);
  });

  it("merges a pre-registration email contact with an existing user-id contact", async () => {
    await db.insert(userContacts).values([
      {
        id: "uct_email",
        ownerUserId: "usr_owner",
        contactUserId: null,
        email: "maruf@example.com",
        normalizedEmail: "maruf@example.com",
        displayName: "Maruf",
        source: "invitation",
        meetingCount: 0,
        createdAt,
        updatedAt: createdAt,
      },
      {
        id: "uct_user",
        ownerUserId: "usr_owner",
        contactUserId: "usr_maruf",
        email: null,
        normalizedEmail: null,
        displayName: "Maruf Hasan",
        source: "meeting",
        firstMetAt: createdAt,
        lastMetAt: createdAt,
        meetingCount: 1,
        lastMeetingId: null,
        createdAt,
        updatedAt: createdAt,
      },
    ]);

    await rememberInvitedContacts(
      db,
      { id: "usr_owner", email: "atiq@example.com" },
      [{ email: "maruf@example.com" }],
      new Date(createdAt.getTime() + 1_000),
    );

    const rows = await db.query.userContacts.findMany({ where: { ownerUserId: "usr_owner" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "uct_user",
      contactUserId: "usr_maruf",
      normalizedEmail: "maruf@example.com",
      meetingCount: 1,
      source: "invitation",
    });
  });

  it("materializes opaque authenticated co-attendees for the meeting owner exactly once", async () => {
    await seedPersonalSpace(db, "usr_owner");
    await db.insert(meetingLinks).values({
      id: "mln_contacts",
      code: "con-tact-idx",
      reusePolicy: "one_time",
      spaceId: "usr_owner_space",
spaceKind: "personal" as const,
      title: "Contacts",
      allowGuests: true,
      joinPolicy: "open",
      createdAt,
      updatedAt: createdAt,
    });
    await db.insert(meetings).values({
      id: "mtg_contacts",
      meetingLinkId: "mln_contacts",
    spaceId: "usr_owner_space",
    spaceKind: "personal" as const,
      title: "Contacts",
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
    for (const [index, userId] of ["usr_owner", "usr_maruf"].entries()) {
      const admissionId = `mad_contacts_${index}`;
      await db.insert(meetingAdmissions).values({
        id: admissionId,
        meetingId: "mtg_contacts",
        subjectType: "user",
        subjectUserId: userId,
        displayName: userId,
        admissionStatus: "approved",
        decidedAt: createdAt,
        createdAt,
        updatedAt: createdAt,
      });
      await db.insert(meetingConnections).values({
        id: `mcn_contacts_${index}`,
        meetingId: "mtg_contacts",
        admissionId,
        livekitIdentity: `identity_${index}`,
        userId,
        role: index === 0 ? "host" : "attendee",
        connectionStatus: "ended",
        tokenIssuedAt: createdAt,
        connectedAt: createdAt,
        disconnectedAt: new Date(createdAt.getTime() + 30 * 60_000),
        createdAt,
        updatedAt: new Date(createdAt.getTime() + 30 * 60_000),
      });
    }
    const metAt = new Date(createdAt.getTime() + 30 * 60_000);
    await indexMeetingContacts(db, "mtg_contacts");
    await indexMeetingContacts(db, "mtg_contacts");

    await expect(db.query.userContacts.findFirst({
      where: { ownerUserId: "usr_owner", contactUserId: "usr_maruf" },
    })).resolves.toMatchObject({
      contactUserId: "usr_maruf",
      email: null,
      normalizedEmail: null,
      source: "meeting",
      meetingCount: 1,
      lastMeetingId: "mtg_contacts",
      firstMetAt: metAt,
      lastMetAt: metAt,
    });
    expect(await db.query.userContacts.findMany()).toHaveLength(1);
    await expect(db.query.userContacts.findFirst({
      where: { ownerUserId: "usr_maruf", contactUserId: "usr_owner" },
    })).resolves.toBeUndefined();

    const search = await searchAutomationTargets(db, "usr_owner", "Maruf");
    expect(search.candidates).toEqual([
      expect.objectContaining({ type: "contact", name: "Maruf Hasan", userId: "usr_maruf" }),
    ]);
    expect(search.candidates[0]).not.toHaveProperty("email");
  });

  it("searches contacts and Spaces without resolving ambiguous names", async () => {
    await rememberInvitedContacts(
      db,
      { id: "usr_owner", email: "atiq@example.com" },
      [
        { email: "maruf@example.com" },
        { email: "rahman@example.com" },
      ],
      createdAt,
    );
    await db.insert(spaces).values({
      kind: "shared",
      id: "spc_math_201",
      name: "Math_201 Class",
      ownerUserId: "usr_owner",
      slug: "math-201-class",
      createdAt,
      updatedAt: createdAt,
    });
    await db.insert(spaceMembers).values({
      id: "spm_math_owner",
      spaceId: "spc_math_201",
      userId: "usr_owner",
      role: "admin",
      joinedAt: createdAt,
    });

    const maruf = await searchAutomationTargets(db, "usr_owner", "Maruf");
    expect(maruf.requiresConfirmation).toBe(true);
    expect(maruf.candidates).toMatchObject([
      { type: "contact", name: "Maruf Hasan", email: "maruf@example.com" },
      { type: "contact", name: "Maruf Rahman", email: "rahman@example.com" },
    ]);

    const math = await searchAutomationTargets(db, "usr_owner", "math_201");
    expect(math).toMatchObject({
      requiresConfirmation: false,
      candidates: [{ type: "space", id: "spc_math_201", name: "Math_201 Class", memberCount: 1 }],
    });

    await expect(resolveAutomationContactNames(
      db,
      "usr_owner",
      ["Maruf Hasan"],
    )).resolves.toEqual([expect.any(String)]);
    await expect(resolveAutomationContactNames(
      db,
      "usr_owner",
      ["Maruf"],
    )).rejects.toMatchObject({
      code: "AMBIGUOUS_CONTACT",
      data: {
        selector: "Maruf",
        candidates: [
          expect.not.objectContaining({ id: expect.anything() }),
          expect.not.objectContaining({ id: expect.anything() }),
        ],
      },
    });
    await expect(resolveAutomationSpaceName(
      db,
      "usr_owner",
      "Math_201",
    )).resolves.toBe("spc_math_201");
  });

  it("offers only Spaces the user manages as automation targets", async () => {
    // Membership alone does not make a Space a target; managing it does.
    await seedSharedSpace(db, {
      id: "spc_member",
      name: "Physics Club",
      ownerUserId: "usr_maruf",
      members: [{ userId: "usr_owner", role: "member" }, { userId: "usr_maruf", role: "owner" }],
      now: createdAt,
    });
    await seedSharedSpace(db, {
      id: "spc_admin",
      name: "Physics Lab",
      ownerUserId: "usr_maruf",
      members: [{ userId: "usr_owner", role: "admin" }],
      now: createdAt,
    });

    const search = await searchAutomationTargets(db, "usr_owner", "Physics");
    expect(search.candidates.map((candidate) => candidate.id)).toEqual(["spc_admin"]);
  });

  it("treats LIKE metacharacters in contact names and emails literally", async () => {
    await rememberInvitedContacts(
      db,
      { id: "usr_owner", email: "atiq@example.com" },
      [{ email: "john_doe@example.com", displayName: "John_Doe" }],
      createdAt,
    );

    await expect(searchAutomationTargets(db, "usr_owner", "john_doe")).resolves.toMatchObject({
      requiresConfirmation: false,
      candidates: [{ type: "contact", name: "John_Doe", email: "john_doe@example.com" }],
    });
    await expect(resolveAutomationContactNames(
      db,
      "usr_owner",
      ["John_Doe"],
    )).resolves.toEqual([expect.any(String)]);
  });
});

// Space resolution used to run the mixed contact+space search and slice the
// combined result to 20 before filtering for Spaces, so same-name contacts
// could crowd Spaces out of the ambiguity check entirely.
describe("space-name resolution", () => {
  async function seedContact(id: string, displayName: string) {
    await db.insert(userContacts).values({
      id,
      ownerUserId: "usr_owner",
      contactUserId: null,
      email: `${id}@example.com`,
      normalizedEmail: `${id}@example.com`,
      displayName,
      source: "manual",
    });
  }

  async function seedManagedSpace(
    id: string,
    name: string,
    members: Array<{ userId: string; role: "owner" | "admin" | "member" }> = [
      { userId: "usr_owner", role: "owner" },
    ],
  ) {
    await seedSharedSpace(db, { id, name, ownerUserId: "usr_owner", members });
  }

  it("resolves a Space crowded out by 20 same-name contacts", async () => {
    for (let i = 0; i < 20; i++) await seedContact(`uct_dup_${i}`, "Dup Space");
    await seedManagedSpace("spc_dup_only", "Dup Space");

    await expect(resolveAutomationSpaceName(db, "usr_owner", "Dup Space"))
      .resolves.toBe("spc_dup_only");
  });

  it("reports AMBIGUOUS_SPACE when two same-name Spaces trail 19 same-name contacts", async () => {
    for (let i = 0; i < 19; i++) await seedContact(`uct_dup_${i}`, "Dup Space");
    await seedManagedSpace("spc_dup_a", "Dup Space");
    await seedManagedSpace("spc_dup_b", "Dup Space");

    await expect(resolveAutomationSpaceName(db, "usr_owner", "Dup Space"))
      .rejects.toMatchObject({
        code: "AMBIGUOUS_SPACE",
        statusCode: 409,
        data: {
          selector: "Dup Space",
          candidates: [{ name: "Dup Space" }, { name: "Dup Space" }],
        },
      });
  });

  it("reports AMBIGUOUS_SPACE for two same-name Spaces with no contacts at all", async () => {
    await seedManagedSpace("spc_dup_a", "Dup Space");
    await seedManagedSpace("spc_dup_b", "Dup Space");

    await expect(resolveAutomationSpaceName(db, "usr_owner", "Dup Space"))
      .rejects.toMatchObject({ code: "AMBIGUOUS_SPACE", statusCode: 409 });
  });

  it("still resolves unique exact and substring matches, and misses unknown names", async () => {
    await seedManagedSpace("spc_alpha", "Alpha Team");
    await seedManagedSpace("spc_math", "Math_201 Class");

    await expect(resolveAutomationSpaceName(db, "usr_owner", "Alpha Team"))
      .resolves.toBe("spc_alpha");
    await expect(resolveAutomationSpaceName(db, "usr_owner", "Math_201"))
      .resolves.toBe("spc_math");
    await expect(resolveAutomationSpaceName(db, "usr_owner", "Missing"))
      .rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
  });

  it("counts only manageable, live Spaces toward resolution and ambiguity", async () => {
    // Someone else's Space, with no membership for usr_owner at all.
    await seedSharedSpace(db, {
      id: "spc_maruf_dup",
      name: "Dup Space",
      ownerUserId: "usr_maruf",
      members: [{ userId: "usr_maruf", role: "owner" }],
    });
    await expect(resolveAutomationSpaceName(db, "usr_owner", "Dup Space"))
      .rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });

    // Plain membership without owner/admin is not manageable either, so the
    // single manageable Space resolves without picking up the ambiguity.
    await seedSharedSpace(db, {
      id: "spc_maruf_dup2",
      name: "Dup Space",
      ownerUserId: "usr_maruf",
      members: [
        { userId: "usr_maruf", role: "owner" },
        { userId: "usr_owner", role: "member" },
      ],
    });
    await seedManagedSpace("spc_owner_dup", "Dup Space");
    await expect(resolveAutomationSpaceName(db, "usr_owner", "Dup Space"))
      .resolves.toBe("spc_owner_dup");

    // Archived Spaces drop out of the candidate set.
    await db.update(spaces)
      .set({ archivedAt: new Date() })
      .where(eq(spaces.id, "spc_owner_dup"));
    await expect(resolveAutomationSpaceName(db, "usr_owner", "Dup Space"))
      .rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
  });

  it("treats more same-name Spaces than the candidate cap as ambiguous", async () => {
    // One past the cap must still resolve as ambiguous instead of truncating
    // to an arbitrary unique-looking match.
    for (let i = 0; i <= SPACE_RESOLUTION_CANDIDATE_CAP; i++) {
      await seedManagedSpace(`spc_flood_${i}`, "Flood Space");
    }

    await expect(resolveAutomationSpaceName(db, "usr_owner", "Flood Space"))
      .rejects.toMatchObject({ code: "AMBIGUOUS_SPACE", statusCode: 409 });
  });
});
