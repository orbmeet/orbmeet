import * as v from "valibot";
import { emailSchema } from "@orbmeet/public-api-contract/fields";

/** One address per comma, semicolon or line, as people paste them. */
export function parseGuestEmails(text: string): string[] {
  return text.split(/[\n,;]+/).map((email) => email.trim()).filter(Boolean);
}

/** The addresses the server would refuse, by the server's own rule. */
export function invalidGuestEmails(emails: readonly string[]): string[] {
  return emails.filter((email) => !v.safeParse(emailSchema, email).success);
}

/** What to say under the guest field, naming exactly what needs fixing. */
export function guestEmailProblem(invalid: readonly string[]): string | null {
  if (invalid.length === 0) return null;
  if (invalid.length === 1) return `“${invalid[0]}” isn’t a complete email address.`;
  return `These aren’t complete email addresses: ${invalid.map((email) => `“${email}”`).join(", ")}.`;
}

const FORM_FIELD_PREFIX =
  /^(?:title|startsAt|durationMinutes|timeZone|spaceId|meetingLinkId|attendees|joinPolicy|reminderMinutesBefore|idempotencyKey)(?:\.\w+)*:\s+/;

/** Validation errors arrive as "attendees.0.email: …"; the path is for developers. */
export function readableScheduleError(message: string): string {
  return message.replace(FORM_FIELD_PREFIX, "");
}
