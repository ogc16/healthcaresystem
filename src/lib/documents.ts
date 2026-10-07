/**
 * Server-side access control for patient identification documents.
 *
 * Documents live in Appwrite storage, but the bucket is deliberately NOT
 * publicly readable: a browser-facing `/view?project=` URL would expose PHI to
 * anyone who holds the link, and the bucket-level read-any permission made that
 * link valid. The only entry point is this module's policy, applied in the
 * `/api/documents/[fileId]` route: a patient may stream their own uploaded
 * document, and an admin may stream any of them.
 */
import { Query } from "node-appwrite";

import type { Patient } from "@/types/appwrite.types";

import {
  BUCKET_ID,
  DATABASE_ID,
  PATIENT_COLLECTION_ID,
  getDatabases,
  getStorage,
} from "./appwrite.config";
import type { AppSession } from "./auth/guards";
import { decryptPhiIfNeeded } from "./phi-crypto";

/** Pure policy: may `session` stream `fileId` given the caller's patient record? */
export const canAccessDocument = (
  session: AppSession | null,
  fileId: string,
  patient: Patient | undefined
): boolean => {
  if (!session) return false;

  if (session.role === "admin") return true;

  if (session.role !== "patient" || !session.userId || !patient) return false;

  return (
    patient.userId === session.userId &&
    patient.identificationDocumentId === fileId
  );
};

/**
 * Loads the caller's patient record from Appwrite, decrypting PHI fields so the
 * policy and any downstream consumer see readable values. Used by the document
 * route and the patient dashboard reads.
 */
export const getPatientByUserId = async (userId: string): Promise<Patient | undefined> => {
  const { documents } = await getDatabases().listDocuments<Patient>(
    DATABASE_ID!,
    PATIENT_COLLECTION_ID!,
    [Query.equal("userId", [userId])]
  );

  const patient = documents[0];

  if (!patient) return undefined;

  return {
    ...patient,
    address: decryptPhiIfNeeded(patient.address),
    emergencyContactName: decryptPhiIfNeeded(patient.emergencyContactName),
    emergencyContactNumber: decryptPhiIfNeeded(patient.emergencyContactNumber),
    insurancePolicyNumber: decryptPhiIfNeeded(patient.insurancePolicyNumber),
    allergies: decryptPhiIfNeeded(patient.allergies ?? ""),
    currentMedication: decryptPhiIfNeeded(patient.currentMedication ?? ""),
    familyMedicalHistory: decryptPhiIfNeeded(patient.familyMedicalHistory ?? ""),
    pastMedicalHistory: decryptPhiIfNeeded(patient.pastMedicalHistory ?? ""),
    identificationType: decryptPhiIfNeeded(patient.identificationType ?? ""),
    identificationNumber: decryptPhiIfNeeded(patient.identificationNumber ?? ""),
  };
};

/**
 * Streams a file's bytes for an already-authorized request. Fetches metadata
 * (for the true MIME type) and the bytes together; the caller decides whether
 * the requester may see the file at all.
 */
export const getDocumentBytes = async (fileId: string) => {
  const file = await getStorage().getFile(BUCKET_ID!, fileId);
  const bytes = await getStorage().getFileDownload(BUCKET_ID!, fileId);

  return { name: file.name, mimeType: file.mimeType, bytes };
};