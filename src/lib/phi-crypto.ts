/**
 * Application-level field encryption for Protected Health Information (PHI).
 *
 * Appwrite stores attributes as plaintext, so fields that would be harmful to
 * read at rest — medical history, national identification numbers, insurance
 * policy numbers — are encrypted here, before a document is written, with
 * AES-256-GCM under a key that lives only in the deployment environment.
 *
 * Format of an encrypted value: `v1:<iv hex>:<auth tag hex>:<ciphertext base64>`.
 * GCM authenticates the ciphertext, so a tampered or truncated value fails
 * decryption instead of silently yielding garbage; callers must treat that as
 * an integrity failure, never as an empty field.
 *
 * Deliberately not applied to identity fields the rest of the system queries
 * on (userId, email, phone, primaryPhysician) or to datetime/boolean
 * attributes: encrypted values cannot be used in Appwrite query filters, which
 * is exactly why they are safe to store.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { env } from "./env";

export const PHI_ENCRYPTION_KEY_ENV = "PHI_ENCRYPTION_KEY";

/**
 * Patient-document fields encrypted before storage and decrypted on read.
 * Deliberately excludes fields the system must query or identity fields that
 * gate access (userId, email, phone, primaryPhysician, identificationDocumentId).
 */
export const PHI_TEXT_FIELDS = [
  "address",
  "emergencyContactName",
  "emergencyContactNumber",
  "insurancePolicyNumber",
  "allergies",
  "currentMedication",
  "familyMedicalHistory",
  "pastMedicalHistory",
  "identificationType",
  "identificationNumber",
] as const;

const CIPHER = "aes-256-gcm";
const VERSION = "v1";

const deriveKey = (): Buffer => {
  const hex = env[PHI_ENCRYPTION_KEY_ENV];

  if (!hex) {
    throw new Error(
      `Missing required environment variable ${PHI_ENCRYPTION_KEY_ENV}. See .env.example.`
    );
  }

  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error(
      `${PHI_ENCRYPTION_KEY_ENV} must be 64 hex characters (32 random bytes).`
    );
  }

  return Buffer.from(hex, "hex");
};

/** Prefix of a value produced by this module, so decryptors can skip plaintext. */
const PREFIX = `${VERSION}:`;

export const isEncryptedPhi = (value: string): boolean =>
  /^v1:[0-9a-f]{24}:[0-9a-f]{32}:[A-Za-z0-9+/=]+$/.test(value);

export const encryptPhi = (plaintext: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv(CIPHER, deriveKey(), iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return `${PREFIX}${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("base64")}`;
};

/**
 * Returns the plaintext for a value stored by `encryptPhi`. Throws when the
 * value is not in the expected format or fails GCM authentication.
 */
export const decryptPhi = (value: string): string => {
  const [version, ivHex, tagHex, ciphertext] = value.split(":");

  if (
    version !== VERSION ||
    ivHex === undefined ||
    tagHex === undefined ||
    ciphertext === undefined
  ) {
    throw new Error("Malformed encrypted PHI value");
  }

  const decipher = createDecipheriv(CIPHER, deriveKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
};

/**
 * Encrypts a value only when it carries PHI; non-strings, empty strings and
 * null are returned untouched. Keeps callers from special-casing every field.
 */
export const encryptPhiIfNeeded = (value: unknown): unknown => {
  if (typeof value !== "string" || value === "") return value;

  return encryptPhi(value);
};

/**
 * Decryption that tolerates pre-encryption data. Values that were never
 * encrypted, or are empty, come back unchanged; genuine ciphertext is
 * decrypted. A failure to authenticate is re-thrown rather than masked.
 */
export const decryptPhiIfNeeded = (value: string): string => {
  if (value === "") return value;

  if (!isEncryptedPhi(value)) return value;

  return decryptPhi(value);
};