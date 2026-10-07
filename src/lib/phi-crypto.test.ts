import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PHI_ENCRYPTION_KEY_ENV,
  PHI_TEXT_FIELDS,
  decryptPhi,
  decryptPhiIfNeeded,
  encryptPhi,
  encryptPhiIfNeeded,
  isEncryptedPhi,
} from "./phi-crypto";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

beforeEach(() => {
  process.env[PHI_ENCRYPTION_KEY_ENV] = KEY;
});

afterEach(() => {
  delete process.env[PHI_ENCRYPTION_KEY_ENV];
});

describe("encryptPhi / decryptPhi", () => {
  it("round-trips a value", () => {
    const token = encryptPhi("Family history of hypertension");

    expect(isEncryptedPhi(token)).toBe(true);
    expect(decryptPhi(token)).toBe("Family history of hypertension");
  });

  it("produces different ciphertext for the same plaintext (unique IV)", () => {
    expect(encryptPhi("same value")).not.toBe(encryptPhi("same value"));
  });

  it("never embeds the plaintext in the token", () => {
    const token = encryptPhi("SSN-123-45-6789");

    expect(token).not.toContain("SSN");
    expect(token).not.toContain("123-45-6789");
  });

  it("rejects a tampered token", () => {
    const token = encryptPhi("allergy: peanuts");

    const tampered = token.slice(0, -2) + (token.endsWith("==") ? "AA" : "!=");

    expect(() => decryptPhi(tampered)).toThrow();
  });

  it("rejects a malformed token", () => {
    expect(() => decryptPhi("not-encrypted-at-all")).toThrow();
  });

  it("fails loudly when the key is missing", () => {
    delete process.env[PHI_ENCRYPTION_KEY_ENV];

    expect(() => encryptPhi("value")).toThrow(/PHI_ENCRYPTION_KEY/);
  });

  it("fails loudly when the key is not 64 hex characters", () => {
    process.env[PHI_ENCRYPTION_KEY_ENV] = "not-a-valid-key";

    expect(() => encryptPhi("value")).toThrow(/64 hex characters/);
  });
});

describe("encryptPhiIfNeeded / decryptPhiIfNeeded", () => {
  it("encrypts only non-empty strings", () => {
    expect(encryptPhiIfNeeded("text")).toBeTypeOf("string");
    expect(encryptPhiIfNeeded("")).toBe("");
    expect(encryptPhiIfNeeded(null)).toBeNull();
    expect(encryptPhiIfNeeded(42)).toBe(42);
    expect(encryptPhiIfNeeded(true)).toBe(true);
  });

  it("decrypts ciphertext and passes plaintext through untouched", () => {
    const plain = "Some legacy plaintext";

    expect(decryptPhiIfNeeded(plain)).toBe(plain);
    expect(decryptPhiIfNeeded(encryptPhi(plain))).toBe(plain);
    expect(decryptPhiIfNeeded("")).toBe("");
  });
});

describe("PHI_TEXT_FIELDS", () => {
  it("covers medical history, national ID and insurance fields", () => {
    expect(PHI_TEXT_FIELDS).toEqual(
      expect.arrayContaining([
        "allergies",
        "currentMedication",
        "familyMedicalHistory",
        "pastMedicalHistory",
        "identificationType",
        "identificationNumber",
        "insurancePolicyNumber",
        "address",
      ])
    );
  });

  it("excludes queryable identity fields", () => {
    expect(PHI_TEXT_FIELDS).not.toEqual(
      expect.arrayContaining([
        "userId",
        "email",
        "phone",
        "primaryPhysician",
        "identificationDocumentId",
      ])
    );
  });
});