/**
 * Server implementations behind the RPC declarations in this directory.
 * Split from the sibling RPC file so the declaration file carries no
 * DB/Drizzle imports and stays safe to include in client route graphs.
 */

import type { Database } from "@orbmeet/db";
import { meetingLinks, spaces, users } from "@orbmeet/db/schema";
import { createMeetingSchema } from "@/modules/meetings/contract/schemas";
import { Errors } from "@/lib/app-errors";
import { generateMeetingCode } from "@/modules/meetings/contract/code-generation";
import { generateId } from "@/lib/ids";
import { ONE_TIME_MEETING_LINK_EXPIRY_MS } from "@/modules/meetings/contract/constants";
import { logError } from "@/lib/logger";
import { getRunChanges, isUniqueConstraintError } from "@/platform/database/db-utils";
import { enforceRateLimit } from "@/platform/http/rate-limit.server";
import { and, eq, isNull, sql } from "drizzle-orm";
import type * as v from "valibot";
import type { AuthFnContext } from "@/app/bootstrap/middleware";
import { normalizePlan } from "@/modules/billing/server/entitlements.server";
import { getPlanLimits } from "@/modules/billing/contract/plan-limits";
import { ensurePersonalSpace } from "@/modules/spaces/server/personal";

export async function insertPersonalMeetingLink(
  db: Database,
  params: {
    meetingLinkId: string;
    code: string;
    spaceId: string;
    spaceKind: "personal";
    title: string | null;
    reusePolicy: "one_time" | "reusable";
    allowGuests: boolean;
    joinPolicy: "open" | "approval_required" | "closed";
    now: Date;
  },
): Promise<void> {
  const {
    meetingLinkId,
    code,
    spaceId,
    spaceKind,
    title,
    reusePolicy,
    allowGuests,
    joinPolicy,
    now,
  } = params;

  const nowSeconds = Math.floor(now.getTime() / 1000);
  const expiresAtSeconds =
    reusePolicy === "reusable"
      ? null
      : Math.floor((now.getTime() + ONE_TIME_MEETING_LINK_EXPIRY_MS) / 1000);
  const insertResult = await db.insert(meetingLinks).select(
    db
      .select({
        id: sql`${meetingLinkId}`.as("id"),
        code: sql`${code}`.as("code"),
        reusePolicy: sql`${reusePolicy}`.as("reuse_policy"),
        spaceId: sql`${spaceId}`.as("space_id"),
        spaceKind: sql`${spaceKind}`.as("space_kind"),
        spentAt: sql`null`.as("spent_at"),
        title: sql`${title}`.as("title"),
        allowGuests: sql`${allowGuests ? 1 : 0}`.as("allow_guests"),
        joinPolicy: sql`${joinPolicy}`.as("join_policy"),
        // Creation is not usage. This becomes non-null only when an occurrence
        // is actually started from the link.
        lastUsedAt: sql`null`.as("last_used_at"),
        // A permanent meeting link is durable. Only a one-time credential expires.
        expiresAt: sql`${expiresAtSeconds}`.as("expires_at"),
        archivedAt: sql`null`.as("archived_at"),
        createdAt: sql`${nowSeconds}`.as("created_at"),
        updatedAt: sql`${nowSeconds}`.as("updated_at"),
      })
      .from(spaces)
      .innerJoin(users, eq(users.id, spaces.ownerUserId))
      .where(
        and(eq(spaces.id, spaceId), eq(spaces.kind, spaceKind), isNull(users.deletionStartedAt)),
      ),
  );
  if (getRunChanges(insertResult) === 0) {
    throw Errors.CONFLICT("Account deletion is already in progress.");
  }
}

export interface ExistingPersonalMeetingLink {
  id: string;
  code: string;
  title: string | null;
  allowGuests: boolean;
  joinPolicy: "open" | "approval_required" | "closed";
}

/**
 * Does the caller's existing permanent link already satisfy this request?
 *
 * Only a `customCode` request names a specific code; without one the caller
 * asked for *a* permanent link and any code satisfies that. Comparing against a
 * missing `customCode` made the match unconditionally false for everyone on a
 * plan without custom codes — the whole free tier — so their retry after a lost
 * response, or a double-submit, was answered with "you already have a permanent
 * meeting link" about the link they had just created.
 */
export function existingLinkMatchesRequest(
  link: ExistingPersonalMeetingLink,
  request: {
    customCode?: string;
    title?: string;
    allowGuests: boolean;
    joinPolicy: "open" | "approval_required" | "closed";
  },
): boolean {
  return (
    (request.customCode === undefined || link.code === request.customCode) &&
    link.title === (request.title ?? null) &&
    link.allowGuests === request.allowGuests &&
    link.joinPolicy === request.joinPolicy
  );
}

function serializeExistingLink(link: ExistingPersonalMeetingLink) {
  return {
    meetingLinkId: link.id,
    code: link.code,
    linkType: "reusable" as const,
    existing: true as const,
  };
}

/**
 * Create a meeting-link credential. The returned `code` is not a
 * Meeting identifier. No Meeting is created here: it starts when
 * the owner starts it through `joinMeeting`, so
 * a link can be created now and shared for later without an idle occurrence.
 */
export async function createMeetingLinkImpl({
  data,
  context: { user, env, db },
}: {
  data: v.InferOutput<typeof createMeetingSchema>;
  context: AuthFnContext;
}) {
  await enforceRateLimit(env, `meeting:create:${user.id}`);

  if (data.spaceId) {
    throw Errors.VALIDATION("Start the meeting from its Space instead.");
  }

  const limits = getPlanLimits(normalizePlan(user.plan));

  if (data.customCode && !limits.customPersonalMeetingCode) {
    throw Errors.FORBIDDEN("Custom personal meeting codes require a Pro or Organization plan");
  }
  if (data.customCode && data.linkType !== "reusable") {
    throw Errors.VALIDATION("Custom meeting codes require a reusable meeting link");
  }

  const now = new Date();
  // Personal links live in the personal space. Ensure on this write path so
  // an account whose provisioning was interrupted heals here.
  const personalSpaceId = await ensurePersonalSpace(db, user, now);

  // A permanent personal meeting link is one stable entrance, not a stream of disposable
  // reusable links. Only an exact retry is idempotent; a request for different
  // settings must not report success while silently returning the old link.
  if (data.linkType === "reusable") {
    const existingLink = await db.query.meetingLinks.findFirst({
      where: {
        spaceId: personalSpaceId,
        spaceKind: "personal",
        reusePolicy: "reusable",
        archivedAt: { isNull: true },
      },
      orderBy: { createdAt: "asc" },
      columns: {
        id: true,
        code: true,
        title: true,
        allowGuests: true,
        joinPolicy: true,
      },
    });
    if (existingLink) {
      if (existingLinkMatchesRequest(existingLink, data)) {
        return serializeExistingLink(existingLink);
      }
      throw Errors.CONFLICT(
        "You already have a permanent meeting link. Remove it before creating another.",
      );
    }
  }
  const MAX_CODE_COLLISION_ATTEMPTS = 3;

  let meetingLinkId = "";
  let code = data.customCode ?? generateMeetingCode();

  for (let attempt = 0; attempt < MAX_CODE_COLLISION_ATTEMPTS; attempt++) {
    meetingLinkId = generateId("MEETING_LINK");
    if (!data.customCode && attempt > 0) code = generateMeetingCode();

    try {
      await insertPersonalMeetingLink(db, {
        meetingLinkId,
        code,
        spaceId: personalSpaceId,
        spaceKind: "personal",
        title: data.title || null,
        reusePolicy: data.linkType,
        allowGuests: data.allowGuests,
        joinPolicy: data.joinPolicy,
        now,
      });
      break;
    } catch (err) {
      const isUniqueCollision = isUniqueConstraintError(err);

      if (isUniqueCollision && data.linkType === "reusable") {
        const concurrentLink = await db.query.meetingLinks.findFirst({
          where: {
            spaceId: personalSpaceId,
            spaceKind: "personal",
            reusePolicy: "reusable",
            archivedAt: { isNull: true },
          },
          columns: {
            id: true,
            code: true,
            title: true,
            allowGuests: true,
            joinPolicy: true,
          },
        });
        if (concurrentLink) {
          if (existingLinkMatchesRequest(concurrentLink, data)) {
            return serializeExistingLink(concurrentLink);
          }
          throw Errors.CONFLICT(
            "You already have a permanent meeting link. Remove it before creating another.",
          );
        }
      }
      if (isUniqueCollision && data.customCode) {
        throw Errors.CONFLICT("That meeting code is already taken. Please choose a different one.");
      }
      if (!isUniqueCollision) {
        // Never log `code`: on a collision it is the code of somebody else's
        // existing link, and it is a live join credential for their meeting.
        logError("[meeting-links] Failed to create meeting link:", { attempt, meetingLinkId }, err);
        throw err;
      }
      if (attempt === MAX_CODE_COLLISION_ATTEMPTS - 1) {
        // Three independent collisions in a 26^10 space. Effectively
        // unreachable, but the caller still deserves the same retryable
        // answer a custom-code clash gets rather than a raw driver error.
        logError(
          "[meeting-links] Exhausted meeting code generation attempts:",
          { attempt, meetingLinkId },
          err,
        );
        throw Errors.CONFLICT("Could not allocate a meeting code. Please try again.");
      }
      // else: retry with a fresh generated code
    }
  }

  return { meetingLinkId, code, linkType: data.linkType, existing: false as const };
}
