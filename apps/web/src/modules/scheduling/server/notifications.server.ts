import "@tanstack/react-start/server-only";

import { createDb } from "@orbmeet/db";
import {
  meetingLinks,
  meetingScheduleAttendees,
  meetingScheduleNotifications,
  meetingSchedules,
  spaces,
  users,
} from "@orbmeet/db/schema";
import { and, asc, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { escapeHtml } from "@/platform/email/html";

import { AUTOMATED_EMAIL_HEADERS, deliverEmail, isEmailConfigured } from "@/platform/email/delivery";
import { normalizeEmailAddress } from "@/platform/email/address";
import { loadSuppressedEmails, recordEmailSuppression } from "@/platform/email/suppression.server";
import { buildUnsubscribeHeaders } from "@/platform/email/unsubscribe-token";

const DELIVERY_BATCH_SIZE = 10;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;
const DELIVERY_CLAIM_LEASE_MS = 5 * 60 * 1000;
const MAX_DELIVERY_ATTEMPTS = 8;
const OUTCOME_UNKNOWN = "Delivery outcome unknown; not sent again, to avoid a duplicate";

function formatScheduledTime(startsAt: Date, endsAt: Date, timeZone: string): string {
  const date = new Intl.DateTimeFormat("en", {
    dateStyle: "full",
    timeZone,
  }).format(startsAt);
  const time = new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  });
  return `${date}, ${time.format(startsAt)}–${time.format(endsAt)}`;
}

function buildScheduleEmail(input: {
  kind: "invitation" | "reminder" | "rescheduled" | "canceled";
  organizerName: string;
  title: string | null;
  startsAt: Date;
  endsAt: Date;
  timeZone: string;
  joinUrl: string;
  cancelReason: string | null;
}) {
  const meetingTitle = input.title?.trim() || "Orb Meet meeting";
  const safeTitle = escapeHtml(meetingTitle);
  const safeOrganizer = escapeHtml(input.organizerName);
  const safeTime = escapeHtml(formatScheduledTime(input.startsAt, input.endsAt, input.timeZone));
  const safeJoinUrl = escapeHtml(input.joinUrl);
  const heading =
    input.kind === "canceled"
      ? "Meeting canceled"
      : input.kind === "rescheduled"
        ? "Meeting rescheduled"
        : input.kind === "reminder"
          ? "Meeting starts soon"
          : "Meeting scheduled";
  const subjectPrefix =
    input.kind === "canceled"
      ? "Canceled"
      : input.kind === "rescheduled"
        ? "Updated"
        : input.kind === "reminder"
          ? "Reminder"
          : "Scheduled";
  const reason = input.cancelReason
    ? `<p style="color:#555"><strong>Reason:</strong> ${escapeHtml(input.cancelReason)}</p>`
    : "";
  const action =
    input.kind === "canceled"
      ? ""
      : `<p style="margin:24px 0"><a href="${safeJoinUrl}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:600">Open meeting</a></p>`;
  const lede =
    input.kind === "reminder"
      ? `${input.organizerName}'s Meeting is coming up: ${meetingTitle}.`
      : `${input.organizerName} ${input.kind === "canceled" ? "canceled" : input.kind === "rescheduled" ? "rescheduled" : "shared a scheduled Meeting with you:"} ${meetingTitle}.`;
  const textAction = input.kind === "canceled" ? "" : `\n\nOpen meeting: ${input.joinUrl}`;
  const textReason = input.cancelReason ? `\n\nReason: ${input.cancelReason}` : "";

  return {
    subject: `${subjectPrefix}: ${meetingTitle}`,
    html: `
      <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#171717">
        <h2 style="margin:0 0 8px">${heading}</h2>
        <p style="color:#555">${input.kind === "reminder" ? `${safeOrganizer}'s Meeting is coming up:` : `${safeOrganizer} ${input.kind === "canceled" ? "canceled" : input.kind === "rescheduled" ? "rescheduled" : "shared a scheduled Meeting with you:"}`} <strong>${safeTitle}</strong>.</p>
        <div style="background:#f5f5f5;border-radius:12px;padding:16px;margin:20px 0">
          <div style="font-weight:600">${safeTime}</div>
        </div>
        ${reason}
        ${action}
        <p style="color:#888;font-size:13px">Sent by Orb Meet on behalf of ${safeOrganizer}.</p>
      </div>
    `,
    text: `${heading}\n\n${lede}\n\n${formatScheduledTime(input.startsAt, input.endsAt, input.timeZone)}${textReason}${textAction}\n\nSent by Orb Meet on behalf of ${input.organizerName}.`,
  };
}

/**
 * Fire a delivery pass without blocking the caller's response. Lives here rather
 * than beside the schedule mutations because those modules are client-reachable
 * (they export server functions), and a `.server` import outside a handler body
 * survives the client build.
 */
export function kickNotificationDelivery(env: Env, ctx: ExecutionContext | undefined) {
  const work = runMeetingScheduleNotificationMaintenance(env).catch(() => 0);
  if (ctx) ctx.waitUntil(work);
  else void work;
}

/**
 * Deliver due schedule notifications, each at most once.
 *
 * The provider has no idempotency key and sets its own Message-ID, so a send
 * that may have been accepted is never repeated: the claim that hands a
 * message to the provider records `deliveryStartedAt`, and only a refusal the
 * provider answered clears it for a retry. A claim whose lease lapsed without
 * settling (the worker died, or its settlement write failed), and a provider
 * failure with no answer, leave the outcome unknown: settled as failed, not
 * sent again.
 */
export async function runMeetingScheduleNotificationMaintenance(
  env: Env,
  now = new Date(),
): Promise<number> {
  if (!isEmailConfigured(env.EMAIL)) return 0;
  const db = createDb(env.DB);
  await db
    .update(meetingScheduleNotifications)
    .set({ status: "failed", lastError: OUTCOME_UNKNOWN })
    .where(and(
      eq(meetingScheduleNotifications.status, "pending"),
      isNotNull(meetingScheduleNotifications.deliveryStartedAt),
      lte(meetingScheduleNotifications.nextAttemptAt, now),
    ));
  const due = await db
    .select({
      notification: meetingScheduleNotifications,
      attendeeEmail: meetingScheduleAttendees.email,
      schedule: meetingSchedules,
      code: meetingLinks.code,
      organizerName: users.name,
      organizerEmail: users.email,
    })
    .from(meetingScheduleNotifications)
    .innerJoin(
      meetingScheduleAttendees,
      eq(meetingScheduleAttendees.id, meetingScheduleNotifications.attendeeId),
    )
    .innerJoin(meetingSchedules, eq(meetingSchedules.id, meetingScheduleNotifications.scheduleId))
    .innerJoin(meetingLinks, eq(meetingLinks.id, meetingSchedules.meetingLinkId))
    .innerJoin(users, eq(users.id, meetingSchedules.organizerUserId))
    .leftJoin(spaces, eq(spaces.id, meetingSchedules.spaceId))
    .where(
      and(
        eq(meetingScheduleNotifications.status, "pending"),
        isNull(meetingScheduleNotifications.deliveryStartedAt),
        lte(meetingScheduleNotifications.nextAttemptAt, now),
        or(
          and(
            eq(meetingScheduleNotifications.kind, "canceled"),
            isNotNull(meetingSchedules.canceledAt),
          ),
          and(
            or(
              eq(meetingScheduleNotifications.kind, "invitation"),
              eq(meetingScheduleNotifications.kind, "reminder"),
              eq(meetingScheduleNotifications.kind, "rescheduled"),
            ),
            isNull(meetingSchedules.canceledAt),
            isNull(meetingLinks.archivedAt),
            // Personal spaces never archive, so this covers both kinds.
            isNull(spaces.archivedAt),
          ),
        ),
      ),
    )
    .orderBy(asc(meetingScheduleNotifications.nextAttemptAt))
    .limit(DELIVERY_BATCH_SIZE);

  // One lookup for the batch: an address we already know is dead should never
  // cost a send to rediscover.
  const suppressed = await loadSuppressedEmails(
    db,
    due.map((item) => item.attendeeEmail),
  );

  let sent = 0;
  for (const item of due) {
    // The claim pushes `nextAttemptAt` out by one lease, and that exact value
    // is this attempt's identity. Every settlement below is fenced on it:
    // delivery can outlive the lease, and once it expires another worker
    // legitimately claims the row — an unfenced "sent"/"failed"/retry write
    // from the older worker would then settle the *newer* worker's attempt.
    const leaseExpiresAt = new Date(now.getTime() + DELIVERY_CLAIM_LEASE_MS);
    const [claimed] = await db
      .update(meetingScheduleNotifications)
      // Claiming is an attempt. Counting it atomically means a Worker crash
      // after this write cannot retry forever without consuming the budget.
      // Claiming also starts delivery. A worker lost before the send leaves
      // a message that was never sent settled as unknown: rare, and the
      // price of never sending one twice.
      .set({
        nextAttemptAt: leaseExpiresAt,
        deliveryStartedAt: now,
        attempts: sql`${meetingScheduleNotifications.attempts} + 1`,
      })
      .where(
        and(
          eq(meetingScheduleNotifications.id, item.notification.id),
          eq(meetingScheduleNotifications.status, "pending"),
          isNull(meetingScheduleNotifications.deliveryStartedAt),
          lte(meetingScheduleNotifications.nextAttemptAt, now),
        ),
      )
      .returning({ attempts: meetingScheduleNotifications.attempts });
    if (!claimed) continue;
    const ownsClaim = and(
      eq(meetingScheduleNotifications.id, item.notification.id),
      eq(meetingScheduleNotifications.status, "pending"),
      eq(meetingScheduleNotifications.nextAttemptAt, leaseExpiresAt),
    );

    const current = await db
      .select({
        schedule: meetingSchedules,
        linkArchivedAt: meetingLinks.archivedAt,
        spaceArchivedAt: spaces.archivedAt,
      })
      .from(meetingSchedules)
      .innerJoin(meetingLinks, eq(meetingLinks.id, meetingSchedules.meetingLinkId))
      .leftJoin(spaces, eq(spaces.id, meetingSchedules.spaceId))
      .where(eq(meetingSchedules.id, item.schedule.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    const currentSchedule = current?.schedule;
    const reminderIsLate = Boolean(
      item.notification.kind === "reminder" &&
      currentSchedule &&
      (currentSchedule.meetingId !== null || now >= currentSchedule.startsAt),
    );
    const invalidNonCancellation =
      item.notification.kind !== "canceled" &&
      Boolean(
        current?.linkArchivedAt ||
        currentSchedule?.canceledAt ||
        (currentSchedule?.spaceId && current?.spaceArchivedAt),
      );
    if (
      !currentSchedule ||
      item.notification.revision < currentSchedule.revision ||
      invalidNonCancellation ||
      reminderIsLate
    ) {
      await db
        .update(meetingScheduleNotifications)
        .set({
          status: "failed",
          sentAt: null,
          lastError: reminderIsLate
            ? "Suppressed because the meeting has already started"
            : invalidNonCancellation
              ? "Suppressed because the meeting is no longer available"
              : "Superseded by a newer revision",
        })
        .where(ownsClaim);
      continue;
    }

    if (suppressed.has(normalizeEmailAddress(item.attendeeEmail))) {
      await db
        .update(meetingScheduleNotifications)
        .set({
          status: "failed",
          sentAt: null,
          lastError: "Suppressed because the recipient no longer accepts mail from us",
        })
        .where(ownsClaim);
      continue;
    }

    const email = buildScheduleEmail({
      kind: item.notification.kind,
      organizerName: item.organizerName,
      title: currentSchedule.title,
      startsAt: currentSchedule.startsAt,
      endsAt: currentSchedule.endsAt,
      timeZone: currentSchedule.timeZone,
      joinUrl: `${env.APP_URL.replace(/\/$/, "")}/${item.code}`,
      cancelReason: currentSchedule.cancelReason,
    });
    // Scheduling mail reaches attendees who never signed up for Orb Meet, so it
    // carries a working one-click opt-out: Gmail and Yahoo expect one from any
    // sender at volume, and `platform/limits.md` requires it for compliance.
    const unsubscribeHeaders = env.AUTH_SECRET
      ? await buildUnsubscribeHeaders({
          email: item.attendeeEmail,
          appUrl: env.APP_URL,
          secret: env.AUTH_SECRET,
        })
      : {};
    const delivery = await deliverEmail(env.EMAIL, {
      to: item.attendeeEmail,
      from: env.EMAIL_FROM_ADDRESS,
      // The sending address is an unattended mailbox, so point replies at the
      // person who actually called the meeting. Attendees already know the
      // organizer invited them; the body says so too.
      replyTo: { email: item.organizerEmail, name: item.organizerName },
      headers: { ...AUTOMATED_EMAIL_HEADERS, ...unsubscribeHeaders },
      ...email,
    });

    if (delivery.accepted) {
      await db
        .update(meetingScheduleNotifications)
        .set({ status: "sent", sentAt: now, lastError: null })
        .where(ownsClaim);
      sent += 1;
      continue;
    }

    // A failure that blames the address, not the attempt: mirror it locally so
    // the next meeting skips this recipient instead of spending another send —
    // and another hard bounce against the <2% reputation target — to learn the
    // same thing. See docs/email-service/concepts/suppressions.md.
    if (delivery.suppression) {
      await recordEmailSuppression(db, {
        email: item.attendeeEmail,
        reason: delivery.suppression,
        providerCode: delivery.code,
        now,
      });
    }

    // A failure the provider did not answer (no error code) may still have
    // been accepted.
    if (delivery.code === null && delivery.failure === "transient") {
      await db
        .update(meetingScheduleNotifications)
        .set({ status: "failed", lastError: OUTCOME_UNKNOWN })
        .where(ownsClaim);
      continue;
    }

    // Refused outright: nothing was sent, so it may be tried again. From the
    // claim, not from the earlier batch SELECT: another worker may have
    // retried this row between the two.
    const attempts = claimed.attempts;
    const terminal = !delivery.retryable || attempts >= MAX_DELIVERY_ATTEMPTS;
    const delayMs = Math.min(MAX_RETRY_DELAY_MS, 60_000 * 2 ** Math.min(attempts - 1, 6));
    await db
      .update(meetingScheduleNotifications)
      .set({
        attempts,
        status: terminal ? "failed" : "pending",
        deliveryStartedAt: null,
        nextAttemptAt: new Date(now.getTime() + delayMs),
        lastError: delivery.error ?? "Email provider did not accept the message",
      })
      .where(ownsClaim);
  }
  return sent;
}
