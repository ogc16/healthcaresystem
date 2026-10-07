/**
 * Append-only audit trail for Protected Health Information.
 *
 * Every read, create and update of a patient record, appointment or document is
 * recorded here with the acting identity, role and target, so a reviewer can
 * answer "who saw what, and when" about PHI. Appwrite offers no immutable
 * storage, so the ledger is append-only *by convention*: the app never updates
 * or deletes these documents, and the operator is expected to lock the
 * collection to update/delete in the console (API-key writes still work).
 *
 * An audit failure must never take down the operation being audited, so writes
 * are fire-and-forget with their own error handling.
 */
import { ID } from "node-appwrite";

import {
  AUDIT_COLLECTION_ID,
  DATABASE_ID,
  getDatabases,
} from "./appwrite.config";
import type { SessionRole } from "./auth/session";

export type AuditAction =
  | "patient.create"
  | "patient.read"
  | "user.read"
  | "appointment.create"
  | "appointment.read"
  | "appointment.list"
  | "appointment.update"
  | "document.read";

export type RecordAuditParams = {
  action: AuditAction;
  resourceType: "patient" | "appointment" | "document" | "user";
  resourceId: string;
  actorRole: SessionRole | "system";
  actorId: string;
  detail?: string;
};

export const recordAudit = async ({
  action,
  resourceType,
  resourceId,
  actorRole,
  actorId,
  detail = "",
}: RecordAuditParams): Promise<void> => {
  try {
    await getDatabases().createDocument(
      DATABASE_ID!,
      AUDIT_COLLECTION_ID!,
      ID.unique(),
      {
        action,
        resourceType,
        resourceId,
        actorRole,
        actorId,
        detail,
      },
      []
    );
  } catch (error) {
    console.error(
      `Audit write failed for ${action} (${resourceType}:${resourceId}):`,
      error
    );
  }
};