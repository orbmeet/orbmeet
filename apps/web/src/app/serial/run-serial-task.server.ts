import "@tanstack/react-start/server-only";
import { createDb } from "@orbmeet/db";
import { addOrganizationMember, removeOrganizationMember } from "@/modules/organizations/server/membership.server";
import { transferOrganizationBillingOwnership } from "@/modules/billing/server/organization-transfer.server";
import { applyPaddleEvent } from "@/modules/billing/server/paddle-webhook.server";
import { reconcileSubscriber } from "@/modules/billing/server/reconciliation.server";
import { preparePaddleCheckout } from "@/modules/billing/server/checkout.server";
import {
  archiveWhiteboard,
  deleteArchivedWhiteboard,
  restoreArchivedWhiteboard,
} from "@/modules/whiteboards/server/api.server";
import { copyWhiteboard } from "@/modules/whiteboards/server/document-revisions";
import { createFirstMeetingWhiteboard } from "@/modules/whiteboards/server/documents";
import { restoreWhiteboardContent } from "@/modules/whiteboards/server/restores";
import { publishMeetingWhiteboardPdf } from "@/modules/whiteboards/server/http/whiteboard-pdf-upload";
import { purgeSpaceWhiteboard } from "@/workflows/space-deletion/cleanup.server";
import type { SerialResults, SerialTask } from "./tasks";

/** Where each kind of serial task lives. */
export async function runSerialTask(env: Env, task: SerialTask): Promise<SerialResults[SerialTask["kind"]]> {
  const db = createDb(env.DB);
  switch (task.kind) {
    case "addOrganizationMember":
      return addOrganizationMember(db, env, task);
    case "removeOrganizationMember":
      return removeOrganizationMember(db, task);
    case "transferOrganizationOwnership":
      return transferOrganizationBillingOwnership(db, env, { ...task, now: new Date(task.acceptedAt) });
    case "applyOrganizationPaddleEvent":
      await applyPaddleEvent(db, task.event, env);
      return null;
    case "reconcileOrganizationOwner":
      return reconcileSubscriber(db, env, task, new Date(task.now));
    case "preparePaddleCheckout":
      return preparePaddleCheckout(db, env, task);
    case "archiveWhiteboard":
      return archiveWhiteboard(db, env, task);
    case "restoreArchivedWhiteboard":
      return restoreArchivedWhiteboard(db, env, task);
    case "deleteArchivedWhiteboard":
      return deleteArchivedWhiteboard(db, env, task);
    case "duplicateWhiteboard":
      return copyWhiteboard(db, env, task);
    case "restoreWhiteboardContent":
      return restoreWhiteboardContent(env, task);
    case "purgeSpaceWhiteboard":
      return purgeSpaceWhiteboard(db, env, task);
    case "createFirstMeetingWhiteboard":
      return createFirstMeetingWhiteboard(db, task);
    case "publishMeetingWhiteboardPdf":
      return publishMeetingWhiteboardPdf(db, env, task);
  }
}
