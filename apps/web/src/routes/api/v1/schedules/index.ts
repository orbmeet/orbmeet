import * as v from "valibot";
import { parseInput } from "@/lib/validation";
import { createFileRoute } from "@tanstack/react-router";
import {
  automationScheduleSelectorSchema,
  createAutomationMeetingScheduleSchema,
  publicScheduleCreateResponseSchema,
  publicScheduleListResponseSchema,
  publicScheduleResponseSchema,
} from "@orbmeet/public-api-contract";
import { Errors } from "@/lib/app-errors";

import {
  resolveAutomationContactNames,
  resolveAutomationSpaceName,
  resolveOwnedContactSeeds,
} from "@/modules/contacts/server/contact-index";
import { apiJson, handleAutomationApi, readAutomationJson } from "@/app/adapters/public-api/http";
import { createMeetingScheduleForUser } from "@/modules/scheduling/server/creation";
import {
  loadIdempotentMeetingScheduleCreate,
  meetingScheduleCreateFingerprint,
} from "@/modules/scheduling/server/commands";
import {
  decodeScheduleCursor,
  listMeetingSchedulesPageForUser,
  resolveManageableMeetingScheduleForUser,
} from "@/modules/scheduling/server/queries.server";
import { getCloudflareCtx } from "@/platform/runtime/server-runtime.server";
import { kickNotificationDelivery } from "@/modules/scheduling/server/notifications.server";

export const Route = createFileRoute("/api/v1/schedules/")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handleAutomationApi(request, "meetings:read", async ({ principal }) => {
          const url = new URL(request.url);
          const includeCanceled = url.searchParams.get("includeCanceled") === "true";
          const hasSelector = ["date", "title", "space", "participant"].some((key) =>
            url.searchParams.has(key),
          );
          if (!hasSelector) {
            const rawLimit = url.searchParams.get("limit");
            const limit = rawLimit === null ? undefined : Number(rawLimit);
            if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
              throw Errors.VALIDATION("limit must be an integer between 1 and 100");
            }
            const rawCursor = url.searchParams.get("cursor");
            const decodedCursor = rawCursor ? decodeScheduleCursor(rawCursor) : null;
            if (rawCursor && !decodedCursor) throw Errors.VALIDATION("Invalid schedule cursor");
            const page = await listMeetingSchedulesPageForUser(principal.db, principal.user, {
              limit,
              cursor: decodedCursor ?? undefined,
            });
            return apiJson(
              v.parse(publicScheduleListResponseSchema, {
                data: page.schedules,
                nextCursor: page.nextCursor,
              }),
            );
          }
          const parsed = parseInput(automationScheduleSelectorSchema, {
            date: url.searchParams.get("date") || undefined,
            timeZone: url.searchParams.get("timezone") || undefined,
            title: url.searchParams.get("title") || undefined,
            space: url.searchParams.get("space") || undefined,
            participant: url.searchParams.get("participant") || undefined,
          });
          // A selector identifies at most one schedule: the resolver either returns
          // that single schedule or throws 404/409. The response is therefore the
          // single-schedule envelope, not the paginated list envelope above.
          return apiJson(
            v.parse(publicScheduleResponseSchema, {
              data: await resolveManageableMeetingScheduleForUser(
                principal.db,
                principal.user,
                parsed,
                undefined,
                { includeCanceled },
              ),
            }),
          );
        }),
      POST: ({ request }) =>
        handleAutomationApi(request, "meetings:write", async ({ env, principal }) => {
          const idempotencyKey = request.headers.get("Idempotency-Key")?.trim();
          if (!idempotencyKey || idempotencyKey.length > 128) {
            throw Errors.VALIDATION(
              "Idempotency-Key is required and must be at most 128 characters",
            );
          }
          const parsed = parseInput(createAutomationMeetingScheduleSchema, await readAutomationJson(request));
          const {
            contactIds,
            contactNames,
            spaceId: requestedSpaceId,
            spaceName,
            ...scheduleInput
          } = parsed;
          // Preserve the normalized public request before mutable contact,
          // Space-name, membership, and default-title resolution.
          const hasSelectors = Boolean(spaceName || contactIds.length || contactNames.length);
          const idempotencyFingerprint = await meetingScheduleCreateFingerprint(
            { ...scheduleInput, spaceId: requestedSpaceId },
            hasSelectors
              ? {
                  spaceName: spaceName?.trim().toLocaleLowerCase() ?? null,
                  contactIds: [...new Set(contactIds)].sort(),
                  contactNames: contactNames.map((name) => name.trim().toLocaleLowerCase()).sort(),
                }
              : undefined,
          );
          const prior = await loadIdempotentMeetingScheduleCreate(
            principal.db,
            principal.user.id,
            idempotencyKey,
            idempotencyFingerprint,
          );
          if (prior) {
            return apiJson(v.parse(publicScheduleCreateResponseSchema, { data: prior }), 201);
          }
          const [namedContactIds, resolvedSpaceId] = await Promise.all([
            resolveAutomationContactNames(principal.db, principal.user.id, contactNames),
            spaceName
              ? resolveAutomationSpaceName(principal.db, principal.user.id, spaceName)
              : Promise.resolve(requestedSpaceId),
          ]);
          const contacts = await resolveOwnedContactSeeds(principal.db, principal.user.id, [
            ...contactIds,
            ...namedContactIds,
          ]);
          const result = await createMeetingScheduleForUser(principal.db, principal.user, {
            ...scheduleInput,
            spaceId: resolvedSpaceId,
            idempotencyKey,
            idempotencyFingerprint,
            attendees: [
              ...scheduleInput.attendees,
              ...contacts.map((contact) => ({
                email: contact.email,
                privateEmail: contact.privateEmail,
                displayName: contact.displayName ?? undefined,
              })),
            ],
          });
          kickNotificationDelivery(env, getCloudflareCtx());
          return apiJson(v.parse(publicScheduleCreateResponseSchema, { data: result }), 201);
        }),
    },
  },
});
