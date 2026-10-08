# ADR-003: AES-256-GCM application-layer encryption for PHI at rest

- Status: Accepted
- Date: 2026-10-08

## Context

HIPAA treats certain patient fields — medical history, medications, allergies,
national identification numbers, insurance policy numbers, contact details of
emergency contacts — as Protected Health Information. Appwrite stores attribute
values as plaintext, and this deployment controls its own Appwrite server, so
"at rest" protection cannot be delegated to a managed TDE knob on the database.
The plaintext fields would be readable by anyone who can read database
documents or a backup, regardless of the app's access controls.

## Decision

Encrypt the PHI-bearing fields in the application, before they are written, and
decrypt on read — all in `src/lib/phi-crypto.ts`.

- AES-256-GCM under `PHI_ENCRYPTION_KEY` (64 hex chars / 32 random bytes), held
  only in the deployment environment.
- Stored value format: `v1:<iv hex>:<auth tag hex>:<ciphertext base64>`. GCM
  authenticates the ciphertext, so tampered or truncated values fail decryption
  loudly instead of degrading to garbage.
- The treated fields are exactly `PHI_TEXT_FIELDS`
  (`src/lib/phi-crypto.ts`). Identity and query fields stay plaintext on
  purpose: `userId`, `email`, `phone`, `primaryPhysician`,
  `identificationDocumentId` must remain filterable, and encrypted values cannot
  be used in Appwrite queries — which is exactly what makes the ciphertext safe
  to store.
- `encryptPhiIfNeeded` / `decryptPhiIfNeeded` tolerate pre-encryption legacy
  data, but never mask a GCM authentication failure.

The key is per-deployment; a key rotation re-encrypts the affected fields.

## Consequences

**Positive.** The release value of an Appwrite backup does not expose the
sensitive profile fields; field-level, not all-or-nothing; GCM detects tampering.

**Negative / constraints.**

- The granular, searchable attributes stay plaintext (they identify the
  record, they do not carry the medical detail).
- All queries are equality/range over unencrypted fields; nobody can grep for a
  plaintext diagnosis.
- Key management and rotation are operational responsibilities; losing the key
  loses the data.

## Considered alternatives

**Database-level encryption / TDE.** Not available on self-hosted Appwrite, and
would encrypt at the volume layer without per-field granularity.

**Server-side field-tokenization service.** Adds infrastructure and a network
hop for every write/read, for the same threat this module covers locally.