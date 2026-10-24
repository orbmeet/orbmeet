import type { Database } from "@orbmeet/db";
import { and, eq, isNull } from "drizzle-orm";
import { Errors } from "@/lib/app-errors";
import { verifyGuestSecret } from "@/platform/crypto/tokens.server";

/**
 * Verify that a raw secret owns an approved guest admission for this Meeting.
 *
 * This module is deliberately independent of request APIs. Background meeting
 * jobs can import it without evaluating TanStack's request-context runtime.
 */
export async function verifyGuestAdmissionBySecret(
  db: Database,
  meetingId: string,
  admissionId: string,
  guestSecret: string | null,
) {
  if (!guestSecret) throw Errors.UNAUTHORIZED();

  const admission = await db.query.meetingAdmissions.findFirst({
    where: {
      RAW: (row) =>
        and(
          eq(row.id, admissionId),
          eq(row.meetingId, meetingId),
          eq(row.admissionStatus, "approved"),
          eq(row.subjectType, "guest"),
          isNull(row.subjectUserId),
        )!,
    },
  });

  if (!admission?.guestSecretHash) throw Errors.FORBIDDEN();
  if (!(await verifyGuestSecret(admission.guestSecretHash, guestSecret))) throw Errors.FORBIDDEN();

  return admission;
}
