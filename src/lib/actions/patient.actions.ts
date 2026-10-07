"use server";

import { ID } from "node-appwrite";
import { InputFile } from "node-appwrite/file";

import {
  BUCKET_ID,
  DATABASE_ID,
  PATIENT_COLLECTION_ID,
  getDatabases,
  getStorage,
  getUsers,
} from "../appwrite.config";
import { recordAudit } from "../audit";
import { requirePatient } from "../auth/guards";
import { createThrottle } from "../auth/throttle";
import { getPatientByUserId } from "../documents";
import {
  PHI_TEXT_FIELDS,
  decryptPhiIfNeeded,
  encryptPhiIfNeeded,
} from "../phi-crypto";
import { UploadValidationError, validateUpload } from "../uploads";
import { parseStringify } from "../utils";

const HOUR_MS = 60 * 60 * 1000;

/** Realistically one, with a little room for a rejected document being retried. */
const registrationAttempts = createThrottle({
  limit: 5,
  overallLimit: 100,
  windowMs: HOUR_MS,
});

// GET USER
/**
 * Resolves the caller's own Appwrite account.
 *
 * This has no userId parameter on purpose. As a `"use server"` export it is
 * reachable over the network, so a parameter would let any caller enumerate
 * another patient's name, email and phone number. The subject comes from the
 * signed session instead.
 */
export const getUser = async () => {
  const { userId } = await requirePatient();

  try {
    const user = await getUsers().get(userId);

    await recordAudit({
      action: "user.read",
      resourceType: "user",
      resourceId: userId,
      actorRole: "patient",
      actorId: userId,
    });

    return parseStringify(user);
  } catch (error) {
    console.error(
      "An error occurred while retrieving the user details:",
      error
    );
  }
};

// REGISTER PATIENT
export const registerPatient = async ({
  identificationDocument,
  ...patient
}: RegisterUserParams) => {
  // Identity comes from the session, never from the payload. Spreading `patient`
  // first and appending `userId` means a caller-supplied userId cannot win.
  const { userId } = await requirePatient();

  // Deliberately before the upload. The upload is the expensive part: an
  // unthrottled caller can push unbounded storage into a bucket that is billed
  // per GB, and a file that passes validation still costs real bytes.
  //
  // Keyed on the session user rather than the address, because a shared or
  // NAT'd address — a hospital network, a mobile carrier CGNAT — would
  // otherwise throttle unrelated patients as one.
  const refused = await registrationAttempts.check(`patient:${userId}`);

  if (refused) throw new Error(refused);

  // Upload file ->  // https://appwrite.io/docs/references/cloud/client-web/storage#createFile
  let file;

  if (identificationDocument) {
    const blob = identificationDocument.get("blobFile") as Blob | null;
    const fileName = identificationDocument.get("fileName") as string | null;

    if (!blob || !fileName) {
      throw new UploadValidationError("The identification document is missing.");
    }

    await validateUpload(blob, fileName);

    const inputFile = InputFile.fromBuffer(
      new Uint8Array(await blob.arrayBuffer()),
      fileName
    );

    file = await getStorage().createFile(
      BUCKET_ID!,
      ID.unique(),
      inputFile
    );
  }

  try {
    // Create new patient document -> https://appwrite.io/docs/references/cloud/server-nodejs/databases#createDocument
    //
    // PHI is encrypted before the document leaves the server: at rest in
    // Appwrite it is ciphertext, and it is decrypted again only when a single
    // authorized identity reads it back (see `getPatientByUserId`). The
    // document's identifier is stored but its file is *never* referenced by a
    // public Appwrite URL — `identificationDocumentUrl` points at the
    // authorized `/api/documents` route instead.
    const phi = Object.fromEntries(
      PHI_TEXT_FIELDS.map((field) => [field, encryptPhiIfNeeded((patient as Record<string, unknown>)[field])])
    );
    const fileId = file?.$id ?? null;

    const newPatient = await getDatabases().createDocument(
      DATABASE_ID!,
      PATIENT_COLLECTION_ID!,
      ID.unique(),
      {
        identificationDocumentId: fileId,
        identificationDocumentUrl: fileId ? `/api/documents/${fileId}` : null,
        ...patient,
        ...phi,
        userId,
      }
    );

    await recordAudit({
      action: "patient.create",
      resourceType: "patient",
      resourceId: newPatient.$id,
      actorRole: "patient",
      actorId: userId,
    });

    // Return a view of the record with encrypted fields readable again, so a
    // client that renders the result of registration never sees ciphertext.
    const decrypted = {
      ...newPatient,
      ...Object.fromEntries(
        PHI_TEXT_FIELDS.map((field) => [
          field,
          decryptPhiIfNeeded((newPatient as unknown as Record<string, string>)[field] ?? ""),
        ])
      ),
    };

    return parseStringify(decrypted);
  } catch (error) {
    console.error("An error occurred while creating a new patient:", error);
  }
};

// GET PATIENT
export const getPatient = async () => {
  const { userId } = await requirePatient();

  try {
    const patient = await getPatientByUserId(userId);

    if (!patient) return undefined;

    await recordAudit({
      action: "patient.read",
      resourceType: "patient",
      resourceId: patient.$id,
      actorRole: "patient",
      actorId: userId,
    });

    return parseStringify(patient);
  } catch (error) {
    console.error(
      "An error occurred while retrieving the patient details:",
      error
    );
  }
};
