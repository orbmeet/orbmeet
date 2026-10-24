import { env as testEnv } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  emailSuppressions,
  meetingScheduleNotifications,
  users,
} from "@orbmeet/db/schema";
import { and, eq } from "drizzle-orm";

import { createTestDb, type TestDb } from "@/test/db";
import type { AuthenticatedUser } from "@/modules/identity/contract/auth/session-user";
import { createMeetingScheduleRecord } from "./commands";

const email = vi.hoisted(() => ({
  deliverEmail: vi.fn(),
}));

vi.mock("@/platform/email/delivery", () => ({
  deliverEmail: email.deliverEmail,
  isEmailConfigured: (binding: unknown) => Boolean(binding),
  AUTOMATED_EMAIL_HEADERS: { "Auto-Submitted": "auto-generated" },
}));

import { runMeetingScheduleNotificationMaintenance } from "./notifications.server";

let db: TestDb;

const organizer: AuthenticatedUser = {
  id: "usr_reminder_host",
  name: "Reminder Host",
  email: "host@example.com",
  image: null,
  timeZone: "Asia/Dhaka",
  transcribeMeetings: true,
  appearance: "system",
  plan: "pro",
  role: "user",
  subscriptionStatus: "active",
  hasManagedSubscription: true,
};

beforeEach(async () => {
  db = await createTestDb();
  email.deliverEmail.mockReset();
  email.deliverEmail.mockResolvedValue({
    accepted: true,
    retryable: false,
    failure: null,
    suppression: null,
    code: null,
    error: null,
  });
  const now = new Date("2026-07-14T09:00:00.000Z");
  await db.insert(users).values({
    id: organizer.id,
    name: organizer.name,
    email: organizer.email,
    normalizedEmail: organizer.email,
    image: null,
    plan: organizer.plan,
    role: organizer.role,
    createdAt: now,
    updatedAt: now,
  });
});

const emailBinding = { send: async () => ({ messageId: "msg_test" }) };

function runtimeEnv(): Env {
  return {
    DB: testEnv.DB,
    APP_URL: "https://meet.example.com",
    AUTH_SECRET: "test-auth-secret-with-at-least-32-characters",
    EMAIL: emailBinding,
    EMAIL_FROM_ADDRESS: "Orb Meet <meet@example.com>",
  } as unknown as Env;
}

/** A schedule whose invitation is already sent, leaving one reminder due. */
async function queueReminder() {
  const createdAt = new Date("2026-07-14T09:00:00.000Z");
  const created = await createMeetingScheduleRecord(db, organizer, {
    title: "Algebra lesson",
    startsAt: "2026-07-14T12:00:00.000Z",
    durationMinutes: 45,
    timeZone: "Asia/Dhaka",
    attendees: [{ email: "student@example.com" }],
    joinPolicy: "open",
    reminderMinutesBefore: 60,
  }, { now: createdAt });

  await db.update(meetingScheduleNotifications).set({
    status: "sent",
    sentAt: createdAt,
  }).where(and(
    eq(meetingScheduleNotifications.scheduleId, created.id),
    eq(meetingScheduleNotifications.kind, "invitation"),
  ));
  return created;
}

function reminderRow(scheduleId: string) {
  return db.query.meetingScheduleNotifications.findFirst({
    where: {
      RAW: (row) => and(eq(row.scheduleId, scheduleId), eq(row.kind, "reminder"))!,
    },
  });
}

describe("scheduled meeting reminders", () => {
  it("delivers the queued reminder with the existing meeting link", async () => {
    const created = await queueReminder();

    await expect(runMeetingScheduleNotificationMaintenance(
      runtimeEnv(),
      new Date("2026-07-14T11:00:00.000Z"),
    )).resolves.toBe(1);

    expect(email.deliverEmail).toHaveBeenCalledWith(
      emailBinding,
      expect.objectContaining({
        to: "student@example.com",
        subject: "Reminder: Algebra lesson",
        replyTo: { email: "host@example.com", name: "Reminder Host" },
        html: expect.stringContaining(`https://meet.example.com/${created.code}`),
        text: expect.stringContaining(`https://meet.example.com/${created.code}`),
        headers: expect.objectContaining({
          "Auto-Submitted": "auto-generated",
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          "List-Unsubscribe": expect.stringContaining(
            "https://meet.example.com/api/email/unsubscribe?token=",
          ),
        }),
      }),
    );
    await expect(reminderRow(created.id)).resolves.toMatchObject({ status: "sent" });
  });

  it("skips a recipient already in the suppression mirror without sending", async () => {
    const created = await queueReminder();
    await db.insert(emailSuppressions).values({
      normalizedEmail: "student@example.com",
      reason: "bounced",
      providerCode: "E_DELIVERY_FAILED",
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
    });

    await expect(runMeetingScheduleNotificationMaintenance(
      runtimeEnv(),
      new Date("2026-07-14T11:00:00.000Z"),
    )).resolves.toBe(0);

    expect(email.deliverEmail).not.toHaveBeenCalled();
    await expect(reminderRow(created.id)).resolves.toMatchObject({
      status: "failed",
      lastError: "Suppressed because the recipient no longer accepts mail from us",
    });
  });

  // A hard bounce is terminal at Cloudflare, so retrying only spends sends and
  // pushes the hard-bounce rate up. Record it and stop.
  it("records a hard bounce and fails the notification without a retry", async () => {
    const created = await queueReminder();
    email.deliverEmail.mockResolvedValue({
      accepted: false,
      retryable: false,
      failure: "recipient",
      suppression: "bounced",
      code: "E_DELIVERY_FAILED",
      error: "Email provider rejected the message (E_DELIVERY_FAILED)",
    });

    await expect(runMeetingScheduleNotificationMaintenance(
      runtimeEnv(),
      new Date("2026-07-14T11:00:00.000Z"),
    )).resolves.toBe(0);

    await expect(reminderRow(created.id)).resolves.toMatchObject({
      status: "failed",
      attempts: 1,
    });
    await expect(db.query.emailSuppressions.findFirst({
      where: { normalizedEmail: "student@example.com" },
    })).resolves.toMatchObject({ reason: "bounced", providerCode: "E_DELIVERY_FAILED" });
  });

  it("still retries a transient provider failure", async () => {
    const created = await queueReminder();
    email.deliverEmail.mockResolvedValue({
      accepted: false,
      retryable: true,
      failure: "transient",
      suppression: null,
      code: "E_RATE_LIMIT_EXCEEDED",
      error: "Email provider rejected the message (E_RATE_LIMIT_EXCEEDED)",
    });

    await expect(runMeetingScheduleNotificationMaintenance(
      runtimeEnv(),
      new Date("2026-07-14T11:00:00.000Z"),
    )).resolves.toBe(0);

    // Refused outright, nothing was sent: it may be claimed again.
    await expect(reminderRow(created.id)).resolves.toMatchObject({
      status: "pending",
      attempts: 1,
      deliveryStartedAt: null,
    });
    await expect(db.query.emailSuppressions.findFirst({
      where: { normalizedEmail: "student@example.com" },
    })).resolves.toBeUndefined();
  });

  it("never resends a message the provider may have accepted without answering", async () => {
    const created = await queueReminder();
    email.deliverEmail.mockResolvedValue({
      accepted: false,
      retryable: true,
      failure: "transient",
      suppression: null,
      code: null,
      error: "Email provider request failed",
    });

    await runMeetingScheduleNotificationMaintenance(runtimeEnv(), new Date("2026-07-14T11:00:00.000Z"));
    await runMeetingScheduleNotificationMaintenance(runtimeEnv(), new Date("2026-07-14T11:30:00.000Z"));

    expect(email.deliverEmail).toHaveBeenCalledTimes(1);
    await expect(reminderRow(created.id)).resolves.toMatchObject({
      status: "failed",
      lastError: expect.stringMatching(/outcome unknown/),
    });
  });

  it("settles a claim whose worker was lost as unknown, and never sends it again", async () => {
    const created = await queueReminder();
    const claimedAt = new Date("2026-07-14T11:00:00.000Z");
    // As a worker that claimed the row and died leaves it.
    await db.update(meetingScheduleNotifications).set({
      deliveryStartedAt: claimedAt,
      attempts: 1,
      nextAttemptAt: new Date(claimedAt.getTime() + 5 * 60_000),
    }).where(and(
      eq(meetingScheduleNotifications.scheduleId, created.id),
      eq(meetingScheduleNotifications.kind, "reminder"),
    ));

    // Still within its lease: left alone.
    await runMeetingScheduleNotificationMaintenance(runtimeEnv(), new Date("2026-07-14T11:02:00.000Z"));
    await expect(reminderRow(created.id)).resolves.toMatchObject({ status: "pending" });

    await runMeetingScheduleNotificationMaintenance(runtimeEnv(), new Date("2026-07-14T11:06:00.000Z"));
    expect(email.deliverEmail).not.toHaveBeenCalled();
    await expect(reminderRow(created.id)).resolves.toMatchObject({
      status: "failed",
      lastError: expect.stringMatching(/outcome unknown/),
    });
  });

  it("counts the attempt when the row is claimed, before provider delivery settles", async () => {
    const created = await queueReminder();
    let settleDelivery!: (value: {
      accepted: boolean;
      retryable: boolean;
      failure: null;
      suppression: null;
      code: null;
      error: null;
    }) => void;
    email.deliverEmail.mockImplementation(() => new Promise((resolve) => {
      settleDelivery = resolve;
    }));

    const maintenance = runMeetingScheduleNotificationMaintenance(
      runtimeEnv(),
      new Date("2026-07-14T11:00:00.000Z"),
    );
    let claimed = await reminderRow(created.id);
    for (let tries = 0; claimed?.attempts !== 1 && tries < 20; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      claimed = await reminderRow(created.id);
    }
    expect(claimed).toMatchObject({ status: "pending", attempts: 1 });

    settleDelivery({
      accepted: true,
      retryable: false,
      failure: null,
      suppression: null,
      code: null,
      error: null,
    });
    await expect(maintenance).resolves.toBe(1);
  });
});
