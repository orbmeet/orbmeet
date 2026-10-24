import * as v from "valibot";
import { createMeetingScheduleSchema } from "@orbmeet/public-api-contract";
import { trimmedText } from "@orbmeet/public-api-contract/fields";

/**
 * The app's own create, which carries an idempotency key the way the public
 * API's `Idempotency-Key` header does.
 *
 * Without one, a create whose response never arrived — a dropped connection, a
 * reloaded tab, a second click on a form that has not navigated yet — put a
 * second identical meeting on the organizer's calendar and sent every attendee
 * a second invitation. The key names the intent, so the retry replays the
 * schedule that already exists; two deliberately identical meetings created in
 * separate sittings carry different keys and both succeed.
 */
export const createMeetingScheduleFromAppSchema = v.pipe(
  v.strictObject({
    ...createMeetingScheduleSchema.entries,
    idempotencyKey: v.optional(trimmedText(128)),
    meetingLinkId: v.optional(v.pipe(v.string(), v.nonEmpty(), v.maxLength(80))),
  }),
  v.forward(
    v.partialCheck(
      [["spaceId"], ["meetingLinkId"]],
      (input) => !(input.spaceId && input.meetingLinkId),
      "Choose either a Space or a personal meeting link",
    ),
    ["meetingLinkId"],
  ),
);
