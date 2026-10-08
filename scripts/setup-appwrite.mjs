// Scaffold every Appwrite resource CarePulse needs on a self-hosted 1.9.x
// server, then print the .env.local block to paste in.
//
// Requires three variables already present in .env.local:
//   NEXT_PUBLIC_ENDPOINT, PROJECT_ID, API_KEY
//
// Usage (from the repo root, Node >= 20.6):
//   node --env-file=.env.local scripts/setup-appwrite.mjs
//
// Safe to re-run as many times as you like: anything that already exists is
// skipped instead of failing.

import {
  Client,
  Databases,
  RelationMutate,
  RelationshipType,
  Storage,
} from "node-appwrite";

const ENDPOINT = process.env.NEXT_PUBLIC_ENDPOINT;
const PROJECT_ID = process.env.PROJECT_ID;
const API_KEY = process.env.API_KEY;

for (const [name, value] of [
  ["NEXT_PUBLIC_ENDPOINT", ENDPOINT],
  ["PROJECT_ID", PROJECT_ID],
  ["API_KEY", API_KEY],
]) {
  if (!value) {
    console.error(
      `Missing ${name}. Add it to .env.local first, then run:\n` +
        `  node --env-file=.env.local scripts/setup-appwrite.mjs`
    );
    process.exit(1);
  }
}

// Fixed conventions; the script prints these back so .env.local is verbatim.
const DATABASE_ID = "carepulse";
const PATIENT_COLLECTION_ID = "patients";
const DOCTOR_COLLECTION_ID = "doctors";
const APPOINTMENT_COLLECTION_ID = "appointments";
const AUDIT_COLLECTION_ID = "audit_log";
const SMS_OUTBOX_COLLECTION_ID = "sms_outbox";
const BUCKET_ID = "carepulse-uploads";

const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;
const ALLOWED_EXTENSIONS = ["jpg", "jpeg", "png", "pdf"];

const client = new Client()
  .setEndpoint(ENDPOINT)
  .setProject(PROJECT_ID)
  .setKey(API_KEY);

const databases = new Databases(client);
const storage = new Storage(client);

const isDuplicate = (error) =>
  error?.code === 409 ||
  /(already exists|already been created)/i.test(error?.message ?? "");

const skipped = (what) => console.log(`  - exists, skipped: ${what}`);

let createdAny = false;

async function ensureDatabase() {
  try {
    const database = await databases.create(DATABASE_ID, "CarePulse");
    console.log(`Created database: ${database.$id}`);
    createdAny = true;
  } catch (error) {
    if (isDuplicate(error)) return skipped(`database ${DATABASE_ID}`);
    throw error;
  }
}

async function ensureCollection(collectionId, name) {
  try {
    const collection = await databases.createCollection(
      DATABASE_ID,
      collectionId,
      name
    );
    console.log(`Created collection: ${collection.$id}`);
    createdAny = true;
    return false;
  } catch (error) {
    if (isDuplicate(error)) {
      skipped(`collection ${collectionId}`);
      return true;
    }
    throw error;
  }
}

async function ensureString(collectionId, key, size, required, xdefault) {
  try {
    await databases.createStringAttribute(
      DATABASE_ID,
      collectionId,
      key,
      size,
      required,
      xdefault
    );
    console.log(`  + string "${key}"`);
    createdAny = true;
  } catch (error) {
    if (isDuplicate(error)) skipped(`attribute ${collectionId}.${key}`);
    else throw error;
  }
}

async function ensureDatetime(collectionId, key, required) {
  try {
    await databases.createDatetimeAttribute(
      DATABASE_ID,
      collectionId,
      key,
      required
    );
    console.log(`  + datetime "${key}"`);
    createdAny = true;
  } catch (error) {
    if (isDuplicate(error)) skipped(`attribute ${collectionId}.${key}`);
    else throw error;
  }
}

async function ensureInteger(collectionId, key, required, xdefault) {
  try {
    await databases.createIntegerAttribute(
      DATABASE_ID,
      collectionId,
      key,
      required,
      0,
      undefined,
      xdefault
    );
    console.log(`  + integer "${key}"`);
    createdAny = true;
  } catch (error) {
    if (isDuplicate(error)) skipped(`attribute ${collectionId}.${key}`);
    else throw error;
  }
}

async function ensureBoolean(collectionId, key, required, xdefault) {
  try {
    await databases.createBooleanAttribute(
      DATABASE_ID,
      collectionId,
      key,
      required,
      xdefault
    );
    console.log(`  + boolean "${key}"`);
    createdAny = true;
  } catch (error) {
    if (isDuplicate(error)) skipped(`attribute ${collectionId}.${key}`);
    else throw error;
  }
}

async function ensureRelationship() {
  try {
    await databases.createRelationshipAttribute(
      DATABASE_ID,
      APPOINTMENT_COLLECTION_ID,
      PATIENT_COLLECTION_ID,
      RelationshipType.ManyToOne,
      true,
      "patient",
      "appointments",
      RelationMutate.Cascade
    );
    console.log(`  + relationship appointment["patient"] -> patients (two-way)`);
    createdAny = true;
  } catch (error) {
    if (isDuplicate(error)) skipped("relationship appointment.patient");
    else throw error;
  }
}

async function ensureBucket() {
  try {
    const bucket = await storage.createBucket(
      BUCKET_ID,
      "CarePulse documents",
      [],
      false,
      true,
      MAX_UPLOAD_BYTES,
      ALLOWED_EXTENSIONS
    );
    console.log(`Created bucket: ${bucket.$id}`);
    createdAny = true;
  } catch (error) {
    if (isDuplicate(error)) return skipped(`bucket ${BUCKET_ID}`);
    throw error;
  }
}

async function ensureAuditLog() {
  // Collection exists check gates the doc says what the collection is FOR;
  // the attributes are added through the idempotent ensure* helpers so a
  // re-run here also upgrades a pre-existing audit_log that predates the
  // hash chain.
  await ensureCollection(AUDIT_COLLECTION_ID, "audit_log");

  await ensureString(AUDIT_COLLECTION_ID, "action", 64, true);
  await ensureString(AUDIT_COLLECTION_ID, "resourceType", 32, true);
  await ensureString(AUDIT_COLLECTION_ID, "resourceId", 255, true);
  await ensureString(AUDIT_COLLECTION_ID, "actorRole", 16, true);
  await ensureString(AUDIT_COLLECTION_ID, "actorId", 255, true);
  await ensureString(AUDIT_COLLECTION_ID, "detail", 2000, false, "");
  await ensureString(AUDIT_COLLECTION_ID, "ip", 255, true, "unknown");
  await ensureInteger(AUDIT_COLLECTION_ID, "seq", true, 0);
  await ensureString(AUDIT_COLLECTION_ID, "prevHash", 64, true, "");
  await ensureString(AUDIT_COLLECTION_ID, "hash", 64, true, "");
  await ensureDatetime(AUDIT_COLLECTION_ID, "occurredAt", true);

  console.log(
    "  NOTE: lock the audit_log collection to update/delete in the console;",
    "the app only ever appends to it."
  );
}

async function ensureSmsOutbox() {
  const exists = await ensureCollection(SMS_OUTBOX_COLLECTION_ID, "sms_outbox");

  if (exists) return;

  await ensureString(SMS_OUTBOX_COLLECTION_ID, "userId", 255, true);
  await ensureString(SMS_OUTBOX_COLLECTION_ID, "content", 2000, true);
  await ensureString(SMS_OUTBOX_COLLECTION_ID, "status", 16, true, "pending");
  await ensureInteger(SMS_OUTBOX_COLLECTION_ID, "attempts", true, 0);
  await ensureDatetime(SMS_OUTBOX_COLLECTION_ID, "nextAttemptAt", true);
  await ensureString(SMS_OUTBOX_COLLECTION_ID, "lastError", 500, false, "");
}

console.log(`Target: ${ENDPOINT}, project ${PROJECT_ID}\n`);

await ensureDatabase();

console.log("\npatients collection");
const patientExists = await ensureCollection(
  PATIENT_COLLECTION_ID,
  "patients"
);
if (!patientExists) {
  // Every field the registration form can send. Fields the zod schema marks
  // optional are stored as non-required attributes with a "" default so blank
  // submissions do not violate a required constraint.
  const strings = [
    ["userId", 255, true],
    ["name", 255, true],
    ["email", 255, true],
    ["phone", 255, true],
    ["gender", 64, true],
    ["address", 500, true],
    ["occupation", 500, true],
    ["emergencyContactName", 255, true],
    ["emergencyContactNumber", 255, true],
    ["primaryPhysician", 255, true],
    ["insuranceProvider", 128, true],
    ["insurancePolicyNumber", 128, true],
    ["identificationDocumentId", 255, true],
    ["identificationDocumentUrl", 1000, true],
    ["allergies", 1000, false, ""],
    ["currentMedication", 1000, false, ""],
    ["familyMedicalHistory", 1000, false, ""],
    ["pastMedicalHistory", 1000, false, ""],
    ["identificationType", 64, false, ""],
    ["identificationNumber", 128, false, ""],
  ];
  for (const [key, size, required, xdefault] of strings) {
    await ensureString(PATIENT_COLLECTION_ID, key, size, required, xdefault);
  }
  await ensureDatetime(PATIENT_COLLECTION_ID, "birthDate", true);
  for (const key of [
    "privacyConsent",
    "treatmentConsent",
    "disclosureConsent",
  ]) {
    await ensureBoolean(PATIENT_COLLECTION_ID, key, true, false);
  }
}

console.log("\ndoctors collection");
const doctorExists = await ensureCollection(DOCTOR_COLLECTION_ID, "doctors");
if (!doctorExists) {
  await ensureString(DOCTOR_COLLECTION_ID, "name", 255, true);
}

console.log("\nappointments collection");
const appointmentExists = await ensureCollection(
  APPOINTMENT_COLLECTION_ID,
  "appointments"
);
if (!appointmentExists) {
  await ensureString(APPOINTMENT_COLLECTION_ID, "userId", 255, true);
  await ensureString(APPOINTMENT_COLLECTION_ID, "primaryPhysician", 255, true);
  await ensureString(APPOINTMENT_COLLECTION_ID, "reason", 500, true);
  await ensureString(APPOINTMENT_COLLECTION_ID, "status", 32, true, "pending");
  await ensureString(APPOINTMENT_COLLECTION_ID, "note", 500, false, "");
  await ensureString(
    APPOINTMENT_COLLECTION_ID,
    "cancellationReason",
    500,
    false,
    ""
  );
  await ensureDatetime(APPOINTMENT_COLLECTION_ID, "schedule", true);
  await ensureRelationship();
}

console.log("\nstorage bucket");
await ensureBucket();

console.log("\naudit_log collection");
await ensureAuditLog();

console.log("\nsms_outbox collection");
await ensureSmsOutbox();

console.log("\n--- .env.local (paste/merge into .env.local) ---");
const phiEncryptionKey = process.env.PHI_ENCRYPTION_KEY
  ? `PHI_ENCRYPTION_KEY="${process.env.PHI_ENCRYPTION_KEY}"`
  : (
      "PHI_ENCRYPTION_KEY=\"<64 hex chars - generate with: " +
      String.raw`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` + ">\""
    );
console.log([
  `NEXT_PUBLIC_ENDPOINT="${ENDPOINT}"`,
  `PROJECT_ID="${PROJECT_ID}"`,
  `API_KEY="${API_KEY}"`,
  `DATABASE_ID="${DATABASE_ID}"`,
  `PATIENT_COLLECTION_ID="${PATIENT_COLLECTION_ID}"`,
  `DOCTOR_COLLECTION_ID="${DOCTOR_COLLECTION_ID}"`,
  `APPOINTMENT_COLLECTION_ID="${APPOINTMENT_COLLECTION_ID}"`,
  `AUDIT_COLLECTION_ID="${AUDIT_COLLECTION_ID}"`,
  `SMS_OUTBOX_COLLECTION_ID="${SMS_OUTBOX_COLLECTION_ID}"`,
  `NEXT_PUBLIC_BUCKET_ID="${BUCKET_ID}"`,
  phiEncryptionKey,
  "",
  "# Optional, recommended: secret that gates the /api/cron/sms drain endpoint.",
  "# Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"",
  "# Then call GET /api/cron/sms with header x-cron-secret=<value> on a schedule.",
  "# CRON_SECRET",
  "",
  "# Optional: how many delivery attempts a queued SMS gets before it is",
  "# marked failed. Default 5; capped exponential backoff between attempts.",
  "# SMS_MAX_ATTEMPTS=5",
  "",
  "# Optional: Twilio SMS (see Messaging > Providers in the Appwrite console).",
  "# Without a provider, booking still works; queued messages just back off",
  "# and eventually fail instead of being delivered.",
  "# TWILIO_ACCOUNT_SID",
  "# TWILIO_AUTH_TOKEN",
  "# TWILIO_PHONE_NUMBER",
].join("\n"));

console.log(
  createdAny
    ? "\nDone. The bucket is private; documents are served through the authenticated /api/documents route."
    : "\nNothing to create - the server already had everything."
);