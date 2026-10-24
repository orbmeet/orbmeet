import type { Database } from "@orbmeet/db";
import {
  meetingConnections,
  spaceMembers,
  spaces,
  userContacts,
  users,
} from "@orbmeet/db/schema";
import { and, asc, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
import { AppError, Errors } from "@/lib/app-errors";
import { boundedStatements } from "@/platform/database/db-batching";
import {
  CONTACT_DISPLAY_NAME_MAX_LENGTH,
  clampToColumnLength,
} from "@/platform/database/db-limits";
import { generateId } from "@/lib/ids";
import type { JobStep } from "@/platform/jobs/jobs";
import { normalizeEmail } from "@/modules/identity/contract/auth/email-normalization";

import { d1UnicodeContains } from "@/platform/database/d1-unicode-like";
import { retainsSpaceManagerSql, spaceRoleSql } from "@/modules/spaces/server/helpers";

export interface ContactSeed {
  email: string;
  /** Delivery address resolved from a contact whose email is private. */
  privateEmail?: boolean;
  displayName?: string | null;
  contactUserId?: string | null;
}

function uniqueContactSeeds(ownerEmail: string, contacts: ContactSeed[]) {
  const normalizedOwnerEmail = normalizeEmail(ownerEmail);
  const unique = new Map<string, ContactSeed & { normalizedEmail: string }>();
  for (const contact of contacts) {
    if (contact.privateEmail) continue;
    const email = contact.email.trim();
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail || normalizedEmail === normalizedOwnerEmail) continue;
    if (!unique.has(normalizedEmail)) {
      unique.set(normalizedEmail, { ...contact, email, normalizedEmail });
    }
  }
  return [...unique.values()];
}

export async function rememberInvitedContacts(
  db: Database,
  owner: { id: string; email: string },
  contacts: ContactSeed[],
  now = new Date(),
): Promise<void> {
  const seeds = uniqueContactSeeds(owner.email, contacts);
  if (seeds.length === 0) return;
  const registeredUsers = await db
    .select({ id: users.id, name: users.name, normalizedEmail: users.normalizedEmail })
    .from(users)
    .where(
      inArray(
        users.normalizedEmail,
        seeds.map((contact) => contact.normalizedEmail),
      ),
    );
  const registeredByEmail = new Map(registeredUsers.map((user) => [user.normalizedEmail, user]));
  const writes = seeds.flatMap((contact) => {
    const registered = registeredByEmail.get(contact.normalizedEmail);
    const contactUserId = contact.contactUserId ?? registered?.id ?? null;
    const values = {
      contactUserId,
      email: contact.email,
      normalizedEmail: contact.normalizedEmail,
      displayName: clampToColumnLength(
        contact.displayName?.trim() || registered?.name || contact.email,
        CONTACT_DISPLAY_NAME_MAX_LENGTH,
      ),
      source: "invitation" as const,
      updatedAt: now,
    };

    if (!contactUserId) {
      return [
        db
          .insert(userContacts)
          .values({
            id: generateId("USER_CONTACT"),
            ownerUserId: owner.id,
            ...values,
            firstMetAt: null,
            lastMetAt: null,
            meetingCount: 0,
            lastMeetingId: null,
            createdAt: now,
          })
          .onConflictDoUpdate({
            target: [userContacts.ownerUserId, userContacts.normalizedEmail],
            set: values,
          }),
      ];
    }

    // A guest invitation can predate account creation, while meeting history
    // may already have created the opaque user-id contact. Reconcile those two
    // unique identities inside one D1 transaction before upserting, so neither
    // unique index can make the other path fail.
    const adoptEmailRow = db
      .update(userContacts)
      .set(values)
      .where(
        and(
          eq(userContacts.ownerUserId, owner.id),
          eq(userContacts.normalizedEmail, contact.normalizedEmail),
          sql`not exists (
          select 1 from ${userContacts} by_user
          where by_user.owner_user_id = ${owner.id}
            and by_user.contact_user_id = ${contactUserId}
        )`,
        ),
      );
    const removeSupersededEmailRow = db.delete(userContacts).where(
      and(
        eq(userContacts.ownerUserId, owner.id),
        eq(userContacts.normalizedEmail, contact.normalizedEmail),
        sql`(${userContacts.contactUserId} is null or ${userContacts.contactUserId} <> ${contactUserId})`,
        sql`exists (
          select 1 from ${userContacts} by_user
          where by_user.owner_user_id = ${owner.id}
            and by_user.contact_user_id = ${contactUserId}
        )`,
      ),
    );
    const insert = db
      .insert(userContacts)
      .values({
        id: generateId("USER_CONTACT"),
        ownerUserId: owner.id,
        ...values,
        firstMetAt: null,
        lastMetAt: null,
        meetingCount: 0,
        lastMeetingId: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [userContacts.ownerUserId, userContacts.contactUserId],
        set: values,
      });
    return [adoptEmailRow, removeSupersededEmailRow, insert];
  });
  const [firstWrite, ...remainingWrites] = writes;
  await db.batch([firstWrite, ...remainingWrites]);
}

/** Co-attendees indexed per job step. */
const CONTACT_INDEX_PAGE_SIZE = 100;

/**
 * Project a meeting's authenticated co-attendees into its owner's private
 * address book, one bounded page per step. Meeting history never copies
 * account email. Each page's write is idempotent, and its step returns the
 * cursor the next page starts after.
 */
export async function indexMeetingContacts(
  step: JobStep,
  db: Database,
  meetingId: string,
): Promise<void> {
  const owner = await step.do("find meeting owner", async () => {
    const meeting = await db.query.meetings.findFirst({
      where: { id: meetingId },
      columns: { startedByUserId: true, endedAt: true },
    });
    if (!meeting?.startedByUserId) return null;
    return { userId: meeting.startedByUserId, metAt: (meeting.endedAt ?? new Date()).getTime() };
  });
  if (!owner) return;

  let cursorUserId: string | null = null;
  for (let page = 1; ; page++) {
    const next: { cursorUserId: string | null; done: boolean } = await step.do(
      `index contacts page ${page}`,
      () => indexContactPage(db, meetingId, owner.userId, new Date(owner.metAt), cursorUserId),
    );
    if (next.done) return;
    cursorUserId = next.cursorUserId;
  }
}

async function indexContactPage(
  db: Database,
  meetingId: string,
  ownerUserId: string,
  metAt: Date,
  afterUserId: string | null,
): Promise<{ cursorUserId: string | null; done: boolean }> {
  const metAtSeconds = Math.floor(metAt.getTime() / 1000);
  const candidates = await db
    .selectDistinct({ userId: meetingConnections.userId })
    .from(meetingConnections)
    .where(
      and(
        eq(meetingConnections.meetingId, meetingId),
        sql`${meetingConnections.userId} is not null`,
        sql`${meetingConnections.connectedAt} is not null`,
        ne(meetingConnections.userId, ownerUserId),
        afterUserId ? gt(meetingConnections.userId, afterUserId) : undefined,
      ),
    )
    .orderBy(asc(meetingConnections.userId))
    .limit(CONTACT_INDEX_PAGE_SIZE + 1);
  const page = candidates.slice(0, CONTACT_INDEX_PAGE_SIZE);
  const contactUserIds = page.flatMap((row) => (row.userId ? [row.userId] : []));

  const writes = boundedStatements(contactUserIds, (userIds) => db.run(sql`
        insert into ${userContacts} (
          id, owner_user_id, contact_user_id, email, normalized_email,
          display_name, source, first_met_at, last_met_at, meeting_count,
          last_meeting_id, created_at, updated_at
        )
        select
          'uct_' || lower(hex(randomblob(16))),
          ${ownerUserId},
          contact_user.id,
          null,
          null,
          contact_user.name,
          'meeting',
          ${metAtSeconds},
          ${metAtSeconds},
          1,
          ${meetingId},
          ${metAtSeconds},
          ${metAtSeconds}
        from ${users} contact_user
        where contact_user.id in (${sql.join(userIds.map((userId) => sql`${userId}`), sql`, `)})
        on conflict(owner_user_id, contact_user_id) do update set
          display_name = excluded.display_name,
          first_met_at = coalesce(first_met_at, excluded.first_met_at),
          last_met_at = max(coalesce(last_met_at, excluded.last_met_at), excluded.last_met_at),
          meeting_count = (
            select count(distinct contact_meeting.id)
            from meetings contact_meeting
            inner join meeting_connections contact_connection
              on contact_connection.meeting_id = contact_meeting.id
            where contact_meeting.started_by_user_id = excluded.owner_user_id
              and contact_connection.user_id = excluded.contact_user_id
              and contact_connection.connected_at is not null
          ),
          last_meeting_id = case
            when last_met_at is null or last_met_at <= excluded.last_met_at
              then excluded.last_meeting_id
            else last_meeting_id
          end,
          updated_at = excluded.updated_at
      `));
  if (writes.length > 0) {
    const [firstWrite, ...remainingWrites] = writes;
    await db.batch([firstWrite, ...remainingWrites]);
  }
  return {
    cursorUserId: page.at(-1)?.userId ?? afterUserId,
    done: candidates.length <= CONTACT_INDEX_PAGE_SIZE,
  };
}

function matchRank(query: string, name: string, email?: string | null): number {
  const normalizedQuery = query.toLocaleLowerCase();
  const normalizedName = name.toLocaleLowerCase();
  const normalizedEmail = email?.toLocaleLowerCase();
  if (normalizedName === normalizedQuery || normalizedEmail === normalizedQuery) return 0;
  if (normalizedName.startsWith(normalizedQuery) || normalizedEmail?.startsWith(normalizedQuery))
    return 1;
  return 2;
}

/**
 * The one definition of "a Space this user can point automation at".
 *
 * Manageable means an owner or admin membership; live means not archived; and
 * the name match is the D1 unicode-aware contains. Both the mixed picker search
 * and the single-name resolver need exactly this set, and they need it to stay
 * the same set — a moderator role added to one, or a soft-delete rule or
 * collation fix applied to one, would leave the other answering a different
 * question, so a Space that resolved uniquely in the picker could come back
 * NOT_FOUND or falsely AMBIGUOUS through scheduling automation. The two callers
 * still shape and order their own rows; only the predicate is shared, because
 * only the predicate has to agree.
 */
function manageableLiveSpaceWhere(userId: string, term: string) {
  return and(
    eq(spaceMembers.userId, userId),
    retainsSpaceManagerSql(spaces.id, userId),
    d1UnicodeContains(spaces.name, term),
  );
}

export async function searchAutomationTargets(
  db: Database,
  userId: string,
  query: string,
  limit = 10,
) {
  const term = query.trim();
  const [contacts, spaceRows] = await Promise.all([
    db
      .select({
        id: userContacts.id,
        name: userContacts.displayName,
        email: userContacts.email,
        contactUserId: userContacts.contactUserId,
        meetingCount: userContacts.meetingCount,
        lastMetAt: userContacts.lastMetAt,
      })
      .from(userContacts)
      .where(
        and(
          eq(userContacts.ownerUserId, userId),
          or(
            d1UnicodeContains(userContacts.displayName, term),
            d1UnicodeContains(userContacts.email, term),
          ),
        ),
      )
      .orderBy(asc(userContacts.displayName))
      .limit(50),
    db
      .select({
        id: spaces.id,
        name: spaces.name,
        role: spaceRoleSql,
        memberCount: sql<number>`(
          select count(*) from ${spaceMembers} members
          where members.space_id = ${spaces.id}
        )`,
      })
      .from(spaceMembers)
      .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
      .where(manageableLiveSpaceWhere(userId, term))
      .orderBy(asc(spaces.name))
      .limit(50),
  ]);

  const candidates = [
    ...contacts.map((contact) => ({
      type: "contact" as const,
      id: contact.id,
      name: contact.name,
      ...(contact.email ? { email: contact.email } : {}),
      userId: contact.contactUserId,
      meetingCount: contact.meetingCount,
      lastMetAt: contact.lastMetAt?.toISOString() ?? null,
      rank: matchRank(term, contact.name, contact.email),
    })),
    ...spaceRows.map((space) => ({
      type: "space" as const,
      id: space.id,
      name: space.name,
      role: space.role,
      memberCount: space.memberCount,
      rank: matchRank(term, space.name),
    })),
  ]
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(({ rank: _rank, ...candidate }) => candidate);

  return {
    query: term,
    candidates,
    requiresConfirmation: candidates.length !== 1,
  };
}

function exactNameCandidates<T extends { name: string }>(query: string, candidates: T[]): T[] {
  const normalized = query.trim().toLocaleLowerCase();
  const exact = candidates.filter((candidate) => candidate.name.toLocaleLowerCase() === normalized);
  return exact.length > 0 ? exact : candidates;
}

export async function resolveAutomationContactNames(
  db: Database,
  ownerUserId: string,
  names: string[],
): Promise<string[]> {
  const uniqueNames = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  if (uniqueNames.length === 0) return [];

  // Resolve every requested name against one read of the owner's contacts. The
  // per-name search issued two queries each (contacts + spaces) in sequence,
  // yet contact resolution never uses the space leg. Fetch every contact that
  // contains any requested name (each name is <=50 LIKE bytes and capped at 10,
  // so this stays well under D1's parameter cap) and match each name in memory.
  const matchingContacts = await db
    .select({
      id: userContacts.id,
      name: userContacts.displayName,
      email: userContacts.email,
      meetingCount: userContacts.meetingCount,
      lastMetAt: userContacts.lastMetAt,
    })
    .from(userContacts)
    .where(
      and(
        eq(userContacts.ownerUserId, ownerUserId),
        or(
          ...uniqueNames.flatMap((name) => {
            return [
              d1UnicodeContains(userContacts.displayName, name),
              d1UnicodeContains(userContacts.email, name),
            ];
          }),
        ),
      ),
    );

  const resolved: string[] = [];
  for (const name of uniqueNames) {
    const term = name.toLocaleLowerCase();
    // The same case-insensitive substring test the SQL LIKE applied, so the
    // in-memory pass narrows exactly the rows this name would have fetched.
    const containing = matchingContacts.filter(
      (contact) =>
        contact.name.toLocaleLowerCase().includes(term) ||
        Boolean(contact.email?.toLocaleLowerCase().includes(term)),
    );
    const candidates = exactNameCandidates(name, containing);
    if (candidates.length === 0) throw Errors.NOT_FOUND(`Contact “${name}”`);
    if (candidates.length > 1) {
      throw new AppError("AMBIGUOUS_CONTACT", `More than one contact matches “${name}”`, 409, {
        selector: name,
        candidates: candidates.map((candidate) => ({
          name: candidate.name,
          meetingCount: candidate.meetingCount,
          lastMetAt: candidate.lastMetAt?.toISOString() ?? null,
          ...(candidate.email ? { email: candidate.email } : {}),
        })),
      });
    }
    resolved.push(candidates[0].id);
  }
  return [...new Set(resolved)];
}

// Sanity cap for one space-name resolution. Ambiguity must be judged over the
// full candidate set, so space resolution never shares a truncation budget
// with contacts — we fetch one row past the cap solely to detect overflow and
// report it as ambiguous rather than silently truncating.
export const SPACE_RESOLUTION_CANDIDATE_CAP = 100;

export async function resolveAutomationSpaceName(
  db: Database,
  ownerUserId: string,
  name: string,
): Promise<string> {
  // Space-only lookup over the same candidate set the picker searches — the
  // predicate is literally shared, so the two cannot drift. It stays a separate
  // query rather than a filter over the mixed search because the old path
  // sliced the combined contact+space result to 20 before filtering for
  // spaces, so enough same-name contacts could crowd every Space out — turning
  // a unique match into a false NOT_FOUND and a double match into a false
  // unique one.
  const spaceRows = await db
    .select({
      id: spaces.id,
      name: spaces.name,
      memberCount: sql<number>`(
        select count(*) from ${spaceMembers} members
        where members.space_id = ${spaces.id}
      )`,
    })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
    .where(manageableLiveSpaceWhere(ownerUserId, name.trim()))
    .orderBy(asc(spaces.name))
    .limit(SPACE_RESOLUTION_CANDIDATE_CAP + 1);

  // More substring matches than the cap means the name is hopelessly
  // ambiguous even if the exact-name subset happens to be small.
  if (spaceRows.length > SPACE_RESOLUTION_CANDIDATE_CAP) {
    throw new AppError("AMBIGUOUS_SPACE", `More than one Space matches “${name}”`, 409, {
      selector: name,
      candidates: spaceRows.slice(0, 10).map((candidate) => ({
        name: candidate.name,
        memberCount: candidate.memberCount,
      })),
      moreCandidates: true,
    });
  }

  // Same exact-name preference as contact resolution: substring matches only
  // stand in when no accessible Space is named exactly as asked.
  const candidates = exactNameCandidates(name, spaceRows);
  if (candidates.length === 0) throw Errors.NOT_FOUND(`Space “${name}”`);
  if (candidates.length > 1) {
    throw new AppError("AMBIGUOUS_SPACE", `More than one Space matches “${name}”`, 409, {
      selector: name,
      candidates: candidates.map((candidate) => ({
        name: candidate.name,
        memberCount: candidate.memberCount,
      })),
    });
  }
  return candidates[0].id;
}

export async function resolveOwnedContactSeeds(
  db: Database,
  ownerUserId: string,
  contactIds: string[],
): Promise<ContactSeed[]> {
  const uniqueIds = [...new Set(contactIds)];
  if (uniqueIds.length === 0) return [];
  const contacts = await db
    .select({
      id: userContacts.id,
      email: sql<string>`coalesce(${userContacts.email}, ${users.email})`,
      privateEmail: sql<boolean>`${userContacts.email} is null`.mapWith(Boolean),
      displayName: userContacts.displayName,
      contactUserId: userContacts.contactUserId,
    })
    .from(userContacts)
    .leftJoin(users, eq(users.id, userContacts.contactUserId))
    .where(and(eq(userContacts.ownerUserId, ownerUserId), inArray(userContacts.id, uniqueIds)));
  if (contacts.length !== uniqueIds.length) throw Errors.NOT_FOUND("Contact");
  return contacts;
}
