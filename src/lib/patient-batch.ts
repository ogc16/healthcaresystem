import { Query } from "node-appwrite";
import type { Models } from "node-appwrite";

/**
 * Eager-loads patient records for a list of appointments in bulk, instead of
 * the N+1 pattern where the admin dashboard fires one patient query per row.
 *
 * Appwrite relations return a related document's id as a plain string, so the
 * dashboard's `appointment.patient.name` only works if the server hydrates the
 * relation itself. The hydration here is batched (one `Query.equal` per chunk
 * of up to `PATIENT_BATCH_SIZE` ids — Appwrite caps the `equal` value array at
 * 100) and then resolved with a lookup map, so the whole list is joined in
 * `O(chunks)` requests plus `O(n)` map lookups; never `O(n)` queries and never
 * an `O(n^2)` find-inside-a-loop.
 *
 * Only the fields the admin table renders are shipped: leaking a patient's
 * ciphertext PHI (or forcing a decryption pass per row) would make hydration
 * itself a data-exposure and a CPU tax. `$id` is always returned by Appwrite.
 */

export const PATIENT_BATCH_SIZE = 100;

export type PatientSummary = { $id: string; name: string };

export type PatientListFn = (
  queries: string[]
) => Promise<{ documents: Models.Document[] }>;

type PatientRefRecord = { patient?: unknown };

/**
 * All distinct, non-empty, string patient ids in first-seen order. Accepts
 * either rows with a `patient` field or bare id strings so the caller does not
 * have to shape its data just to reach the dedup.
 */
export const uniquePatientIds = (
  records: readonly (PatientRefRecord | string)[]
): string[] => {
  const seen = new Set<string>();
  const ids: string[] = [];

  for (const record of records) {
    const id = typeof record === "string" ? record : record.patient;

    if (typeof id === "string" && id !== "" && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }

  return ids;
};

/** Splits ids into chunks Appwrite's `equal` can accept in one request. */
export const chunkIds = (
  ids: readonly string[],
  size: number = PATIENT_BATCH_SIZE
): string[][] => {
  const chunks: string[][] = [];

  for (let index = 0; index < ids.length; index += size) {
    chunks.push(ids.slice(index, index + size));
  }

  return chunks;
};

/**
 * Fetches `{ $id, name }` summaries for every id, using one list query per
 * chunk. The returned map is keyed by patient document id for the O(1) lookups
 * the DOM rendering does afterwards.
 */
export const batchFetchPatientSummaries = async (
  ids: readonly string[],
  listDocuments: PatientListFn
): Promise<Map<string, PatientSummary>> => {
  const lookup = new Map<string, PatientSummary>();

  for (const chunk of chunkIds(uniquePatientIds(ids))) {
    const { documents } = await listDocuments([
      Query.equal("$id", chunk),
      Query.select(["name"]),
      Query.limit(chunk.length),
    ]);

    for (const document of documents) {
      const name = (document as Models.Document & { name?: unknown }).name;

      if (document.$id && typeof name === "string") {
        lookup.set(document.$id, { $id: document.$id, name });
      }
    }
  }

  return lookup;
};

/**
 * Replaces string `patient` refs with the hydrated summary, resolving each row
 * through the lookup map. Rows already carrying an expanded object and rows
 * whose patient was not found pass through untouched.
 */
export const attachPatientSummaries = <T extends PatientRefRecord>(
  records: readonly T[],
  lookup: ReadonlyMap<string, PatientSummary>
): T[] =>
  records.map((record) => {
    if (typeof record.patient !== "string") return record;

    const summary = lookup.get(record.patient);

    return summary ? { ...record, patient: summary } : record;
  });