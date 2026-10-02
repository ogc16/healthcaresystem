"use server";

import { ID, Query } from "node-appwrite";
import { InputFile } from "node-appwrite/file";

import {
  BUCKET_ID,
  DATABASE_ID,
  ENDPOINT,
  PATIENT_COLLECTION_ID,
  PROJECT_ID,
  getDatabases,
  getStorage,
  getUsers,
} from "../appwrite.config";
import { requirePatient } from "../auth/guards";
import { UploadValidationError, validateUpload } from "../uploads";
import { parseStringify } from "../utils";

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
    const newPatient = await getDatabases().createDocument(
      DATABASE_ID!,
      PATIENT_COLLECTION_ID!,
      ID.unique(),
      {
        identificationDocumentId: file?.$id ?? null,
        identificationDocumentUrl: file?.$id
          ? `${ENDPOINT}/storage/buckets/${BUCKET_ID}/files/${file.$id}/view?project=${PROJECT_ID}`
          : null,
        ...patient,
        userId,
      }
    );

    return parseStringify(newPatient);
  } catch (error) {
    console.error("An error occurred while creating a new patient:", error);
  }
};

// GET PATIENT
export const getPatient = async () => {
  const { userId } = await requirePatient();

  try {
    const patients = await getDatabases().listDocuments(
      DATABASE_ID!,
      PATIENT_COLLECTION_ID!,
      [Query.equal("userId", [userId])]
    );

    return parseStringify(patients.documents[0]);
  } catch (error) {
    console.error(
      "An error occurred while retrieving the patient details:",
      error
    );
  }
};
