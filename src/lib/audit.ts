/**
 * Append-only, tamper-evident audit trail for Protected Health Information.
 *
 * Every read, create and update of a patient record, appointment or document is
 * recorded here with the acting identity, role, target, client address and a
 * server-side timestamp, so a reviewer can answer "who saw what, when and from
 * where" about PHI.
 *
 * Tamper-evidence comes from a hash chain rather than from the database: each
 * entry stores `seq`, the SHA-256 `hash` of its own canonical payload, and
 * `prevHash` (the hash of the entry directly before it). The first entry anchors
 * to the constant GENESIS_PREV_HASH. `verifyAuditChain` replays the chain and
 * reports the first entry that no longer lines up, so any backdated edit,
 * deletion or reordering is detected the moment the ledger is replayed.
 *
 * A hash chain only proves integrity when a trusted copy of some entry exists
 * outside the database. The operator should export the ledger to durable,
 * write-once storage (object-lock bucket, offline archive) on a schedule; a
 * verification against that checkpoint then catches wholesale rewrites too.
 *
 * Appwrite offers no CAS, so two concurrent writers can both read the same tail
 * and fork the chain. `appendAuditEntry` bounds this by re-reading the tail on
 * each retry, re-linking to whatever committed in between; `verifyAuditChain`
 * still flags any fork that slips through.
 *
 * An audit failure must never take down the operation being audited, so the
 * public entry point stays fire-and-forget with its own error handling.
 */
import { createHash } from "crypto";

import { ID, Query } from "node-appwrite";

import {
  AUDIT_COLLECTION_ID,
  DATABASE_ID,
  getDatabases,
} from "./appwrite.config";
import type { SessionRole } from "./auth/session";
import { clientAddress } from "./auth/throttle";

export type AuditAction =
  | "patient.create"
  | "patient.read"
  | "user.read"
  | "appointment.create"
  | "appointment.read"
  | "appointment.list"
  | "appointment.update"
  | "document.read"
  | "document.create";

export type AuditResourceType =
  | "patient"
  | "appointment"
  | "document"
  | "user";

/** Everything an entry must record about the access it describes. */
export type RecordAuditParams = {
  action: AuditAction;
  resourceType: AuditResourceType;
  resourceId: string;
  actorRole: SessionRole | "system";
  actorId: string;
  detail?: string;
  /**
   * Client address. Defaults to the request's `x-forwarded-for`/`x-real-ip`;
   * pass this when the caller already resolved an address so the headers stay
   * out of the hash's dependency path.
   */
  ip?: string;
};

/** A stored ledger document: the access record plus chain bookkeeping. */
export type AuditEntry = RecordAuditParams & {
  seq: number;
  /** Server-side timestamp the hash is bound to. */
  occurredAt: string;
  prevHash: string;
  hash: string;
};

/** Anchor for a fresh ledger. The first entry's `prevHash` equals this. */
export const GENESIS_PREV_HASH = "genesis";

/**
 * Worst case this many tails are read and rewrites attempted per entry. Each
 * retry re-links to the newest committed tail, which is what collapses the
 * fork created by a concurrent writer that committed between our read and write.
 */
const MAX_LINK_RETRIES = 3;

/**
 * Deterministic SHA-256 over every chain-bound field of an entry. Excludes
 * `hash` itself, so the stored hash is a pure function of the recorded facts.
 * Field order is fixed on purpose — reordering would silently change digests.
 */
export const ledgerEntryFingerprint = (entry: AuditEntry): string => {
  const canonical = JSON.stringify({
    seq: entry.seq,
    prevHash: entry.prevHash,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    actorRole: entry.actorRole,
    actorId: entry.actorId,
    detail: entry.detail ?? "",
    ip: entry.ip ?? "unknown",
    occurredAt: entry.occurredAt,
  });

  return createHash("sha256").update(canonical).digest("hex");
};

/**
 * Builds the next chain entry for `payload` given the previously committed tail
 * (`null` for a fresh ledger). Pure and injectable, so the chain math never
 * needs a database to be correct.
 */
export const buildLedgerEntry = (
  payload: RecordAuditParams,
  previous: { seq: number; hash: string } | null
): AuditEntry => {
  const seq = previous ? previous.seq + 1 : 1;
  const prevHash = previous ? previous.hash : GENESIS_PREV_HASH;
  const draft: AuditEntry = {
    ...payload,
    seq,
    prevHash,
    occurredAt: new Date().toISOString(),
    hash: "",
  };

  return { ...draft, hash: ledgerEntryFingerprint(draft) };
};

export type ChainCheck =
  | { status: "ok"; entries: number }
  | { status: "broken"; reason: string };

/**
 * Replays a whole ledger and verifies every link. `entries` may arrive in any
 * order; they are re-sorted by `seq` first. An optional `anchor` pins the
 * expected first entry ({ seq, hash }) — pass a trusted external checkpoint to
 * also catch the case where every entry was rewritten from scratch.
 *
 * Detects: content tampering (fingerprint no longer matches the stored hash),
 * deleted entries, duplicated or reordered `seq`s, and a detached head.
 */
export const verifyAuditChain = (
  entries: readonly AuditEntry[],
  anchor?: { seq: number; hash: string }
): ChainCheck => {
  if (entries.length === 0) {
    return { status: "ok", entries: 0 };
  }

  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  let expectedPrev = anchor?.hash ?? GENESIS_PREV_HASH;
  let expectedSeq = anchor ? anchor.seq + 1 : 1;

  for (const entry of sorted) {
    if (entry.seq !== expectedSeq) {
      return {
        status: "broken",
        reason: `expected seq ${expectedSeq} but found ${entry.seq}`,
      };
    }

    if (entry.prevHash !== expectedPrev) {
      return {
        status: "broken",
        reason: `entry ${entry.seq} does not link to its predecessor`,
      };
    }

    if (ledgerEntryFingerprint(entry) !== entry.hash) {
      return {
        status: "broken",
        reason: `entry ${entry.seq} content does not match its hash`,
      };
    }

    expectedSeq += 1;
    expectedPrev = entry.hash;
  }

  return { status: "ok", entries: sorted.length };
};

/**
 * Fire-and-forget: resolves normally even when Appwrite is unreachable, and
 * never rejects. Anything that does fail lands in the server log with the exact
 * entry it was recording.
 */
export const recordAudit = async (params: RecordAuditParams): Promise<void> => {
  try {
    await appendAuditEntry({
      ...params,
      ip: params.ip ?? (await safeClientAddress()),
    });
  } catch (error) {
    console.error(
      `Audit write failed for ${params.action} (${params.resourceType}:${params.resourceId}):`,
      error
    );
  }
};

/**
 * Reads the current tail and appends a linked entry, retrying against a fresh
 * tail when the write conflicts with a concurrently-committed entry. Also used
 * directly by tests with a stubbed database.
 */
export const appendAuditEntry = async (
  record: RecordAuditParams
): Promise<AuditEntry> => {
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_LINK_RETRIES; attempt++) {
    const previous = await fetchTail();
    const entry = buildLedgerEntry(record, previous);

    try {
      await getDatabases().createDocument(
        DATABASE_ID!,
        AUDIT_COLLECTION_ID!,
        ID.unique(),
        entry,
        []
      );

      return entry;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
};

/** The most recently committed entry, or `null` for an empty ledger. */
const fetchTail = async (): Promise<{ seq: number; hash: string } | null> => {
  const { documents } = await getDatabases().listDocuments(
    DATABASE_ID!,
    AUDIT_COLLECTION_ID!,
    [Query.orderDesc("seq"), Query.limit(1)]
  );

  const tail = documents[0] as Partial<AuditEntry> | undefined;

  return tail && typeof tail.seq === "number" && typeof tail.hash === "string"
    ? { seq: tail.seq, hash: tail.hash }
    : null;
};

/**
 * Best-effort client address without ever throwing. Outside a request scope
 * (background jobs, unit tests) `next/headers` has no headers to read, so the
 * shared "unknown" fallback keeps the entry well-formed.
 */
const safeClientAddress = async (): Promise<string> => {
  try {
    return await clientAddress();
  } catch {
    return "unknown";
  }
};