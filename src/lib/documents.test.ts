import { describe, expect, it } from "vitest";

import type { Patient } from "@/types/appwrite.types";

import type { AppSession } from "./auth/guards";
import { canAccessDocument } from "./documents";

const OWNER_SESSION: AppSession = {
  role: "patient",
  userId: "user-b",
};
const ADMIN_SESSION: AppSession = { role: "admin" };

const OWNER_DOCUMENT_ID = "file-owner";
const OTHER_FILE_ID = "file-other";

const patient = (overrides: Partial<Pick<Patient, "userId" | "identificationDocumentId">>) => ({
  $id: "patient-1",
  $sequence: "1",
  $databaseId: "db",
  $collectionId: "patients",
  $createdAt: "",
  $updatedAt: "",
  $permissions: [] as string[],
  userId: "user-b",
  name: "B",
  email: "b@example.com",
  phone: "+15550001000",
  birthDate: new Date(),
  gender: "Female" as const,
  address: "",
  occupation: "",
  emergencyContactName: "",
  emergencyContactNumber: "",
  primaryPhysician: "",
  insuranceProvider: "",
  insurancePolicyNumber: "",
  allergies: undefined,
  currentMedication: undefined,
  familyMedicalHistory: undefined,
  pastMedicalHistory: undefined,
  identificationType: undefined,
  identificationNumber: undefined,
  identificationDocumentId: OWNER_DOCUMENT_ID,
  identificationDocumentUrl: null,
  identificationDocument: undefined,
  privacyConsent: true,
  ...overrides,
});

describe("canAccessDocument", () => {
  it("allows an admin to access any file", () => {
    expect(canAccessDocument(ADMIN_SESSION, OTHER_FILE_ID, patient({}))).toBe(true);
  });

  it("allows a patient to access their own identification document", () => {
    expect(
      canAccessDocument(OWNER_SESSION, OWNER_DOCUMENT_ID, patient({}))
    ).toBe(true);
  });

  it("denies a patient access to another patient's file", () => {
    expect(
      canAccessDocument(OWNER_SESSION, OTHER_FILE_ID, patient({}))
    ).toBe(false);
  });

  it("denies a patient whose record does not reference the file", () => {
    expect(
      canAccessDocument(
        OWNER_SESSION,
        OWNER_DOCUMENT_ID,
        patient({ identificationDocumentId: "file-someone-else" })
      )
    ).toBe(false);
  });

  it("denies a patient with no patient record", () => {
    expect(canAccessDocument(OWNER_SESSION, OWNER_DOCUMENT_ID, undefined)).toBe(false);
  });

  it("denies an anonymous session", () => {
    expect(canAccessDocument(null, OWNER_DOCUMENT_ID, patient({}))).toBe(false);
  });
});