import * as sdk from "node-appwrite";
import type { Models } from "node-appwrite";

import {
  getDatabases,
  getMessaging,
  getStorage,
} from "./appwrite.config";
import type { RecordAuditParams } from "./audit";
import { recordAudit } from "./audit";
import { env } from "./env";

/**
 * Persistent, type-tagged job queue for work too heavy or too slow to run
 * inside a request (PDF generation, reminder fan-out). Jobs live in an
 * Appwrite collection and are picked up by a drain cron (`/api/cron/jobs`)
 * instead of being executed where they are enqueued, so:
 *
 * - a slow handler never blocks the booking that created it,
 * - a crash between enqueue and completion is retried by a later drain,
 * - every step is observable in the collection's `status` field.
 *
 * Semantics are at-least-once, same as the SMS outbox: a drain that dies
 * between running a handler and writing `done` re-runs the job. Handlers must
 * therefore be idempotent enough to tolerate a duplicate (the invoice handler
 * is: a second upload is just a second file, and the notification SMS is
 * de-duplicated by a per-appointment `dedupeKey`).
 */

export const JOB_QUEUE_DRAIN_LIMIT = 10;
export const JOB_MAX_ATTEMPTS_DEFAULT = 5;
export const JOB_BACKOFF_BASE_MS = 60 * 1000;
export const JOB_BACKOFF_CAP_MS = 24 * 60 * 60 * 1000;
export const JOB_LEASE_MS = 5 * 60 * 1000;

export const jobMaxAttempts = () => {
  const parsed = Number.parseInt(env.JOB_MAX_ATTEMPTS, 10);

  return Number.isInteger(parsed) && parsed >= 1
    ? parsed
    : JOB_MAX_ATTEMPTS_DEFAULT;
};

/** Capped exponential backoff between attempts, mirroring the SMS outbox. */
export const nextJobRetryDelayMs = (
  attempt: number,
  baseMs = JOB_BACKOFF_BASE_MS,
  capMs = JOB_BACKOFF_CAP_MS
) => Math.min(baseMs * 2 ** (attempt - 1), capMs);

export type JobStatus = "pending" | "processing" | "done" | "failed";

export interface JobRow extends Models.Document {
  type: string;
  payload: string;
  status: JobStatus;
  attempts: number;
  nextAttemptAt: string;
  claimedAt: string;
  lastError: string;
  result: string;
  completedAt: string;
}

export type JobHandlerCtx = {
  databases: sdk.Databases;
  storage: sdk.Storage;
  messaging: sdk.Messaging;
  now: Date;
  /** Same signature as `recordAudit`, injected so handlers log to the ledger. */
  audit: (entry: RecordAuditParams) => Promise<void>;
};

export type JobHandler = (
  job: JobRow,
  ctx: JobHandlerCtx
) => Promise<{ result?: string }>;

const handlers = new Map<string, JobHandler>();

/**
 * Registers a handler for a job type. The drain looks handlers up here, so a
 * job whose type has no handler never silently evaporates: it is marked failed
 * with a readable reason instead.
 */
export const registerJobHandler = (type: string, handler: JobHandler) => {
  handlers.set(type, handler);
};

export type EnqueueJobInput = {
  type: string;
  payload: Record<string, unknown>;
  /**
   * Deterministic id. Pass one when the job must exist at most once (e.g.
   * `invoice-<appointmentId>`): a second enqueue collides with a 409, which
   * is treated as "already queued" and swallowed.
   */
  jobId?: string;
};

const isDocumentExistsError = (error: unknown) => {
  const candidate = error as { type?: string; status?: number };

  return (
    candidate?.type === "document_already_exists" ||
    candidate?.status === 409
  );
};

/**
 * Records a job for later execution. Best-effort like `enqueueSms`: a failing
 * provider must never take the request that created the work down with it.
 */
export const enqueueJob = async (
  { type, payload, jobId }: EnqueueJobInput,
  { databases = getDatabases() }: { databases?: sdk.Databases } = {}
): Promise<boolean> => {
  const collectionId = env.JOB_QUEUE_COLLECTION_ID;

  try {
    if (!collectionId) {
      throw new Error(
        "Missing required environment variable JOB_QUEUE_COLLECTION_ID. See .env.example."
      );
    }

    await databases.createDocument(
      env.DATABASE_ID,
      collectionId,
      jobId ?? sdk.ID.unique(),
      {
        type,
        payload: JSON.stringify(payload),
        status: "pending",
        attempts: 0,
        nextAttemptAt: new Date().toISOString(),
        claimedAt: "",
        lastError: "",
      }
    );

    return true;
  } catch (error) {
    // A deterministic id colliding with an existing job is the dedupe signal,
    // not an error: the work is already queued.
    if (isDocumentExistsError(error)) return false;

    console.error("Failed to enqueue job:", error);

    return false;
  }
};

/**
 * Claims jobs for one drain run.
 *
 * Two fetches: `pending` jobs whose backoff window has elapsed, plus `processing`
 * jobs whose lease expired (a previous drain died mid-run). Claiming means
 * stamping `status: processing` and `claimedAt`, so a second concurrent drain
 * does not pick the same rows. Appwrite has no compare-and-set, so two drains
 * racing the fetch could claim the same pending row; the run is normally a
 * single cron, and handlers tolerate duplicates.
 */
export const claimDueJobs = async ({
  databases,
  limit,
  now,
  leaseMs,
}: {
  databases: sdk.Databases;
  limit: number;
  now: Date;
  leaseMs: number;
}): Promise<JobRow[]> => {
  const collectionId = env.JOB_QUEUE_COLLECTION_ID;

  if (!collectionId) {
    throw new Error(
      "Missing required environment variable JOB_QUEUE_COLLECTION_ID. See .env.example."
    );
  }

  const iso = now.toISOString();
  const leaseThreshold = new Date(now.getTime() - leaseMs).toISOString();

  const [{ documents: due }, { documents: stale }] = await Promise.all([
    databases.listDocuments<JobRow>(env.DATABASE_ID, collectionId, [
      sdk.Query.equal("status", ["pending"]),
      sdk.Query.lessThanEqual("nextAttemptAt", iso),
      sdk.Query.orderAsc("$createdAt"),
      sdk.Query.limit(limit),
    ]),
    databases.listDocuments<JobRow>(env.DATABASE_ID, collectionId, [
      sdk.Query.equal("status", ["processing"]),
      sdk.Query.lessThanEqual("claimedAt", leaseThreshold),
      sdk.Query.orderAsc("$createdAt"),
      sdk.Query.limit(limit),
    ]),
  ]);

  const claimed = [...due, ...stale].slice(0, limit);

  await Promise.all(
    claimed.map((job) =>
      databases.updateDocument(env.DATABASE_ID, collectionId, job.$id, {
        status: "processing",
        claimedAt: iso,
      })
    )
  );

  return claimed;
};

export type JobDrainResult = Array<{
  $id: string;
  type: string;
  outcome: "done" | "retry" | "failed";
  attempts: number;
  result: string;
}>;

/**
 * Runs one drain of the job queue: claim due jobs, hand each to its registered
 * handler, and persist the terminal state. Success marks the job `done` with
 * the handler's `result`; failure records the attempt, stamps the next retry
 * with capped backoff, and flips to `failed` at `JOB_MAX_ATTEMPTS`.
 */
export const drainJobs = async ({
  databases = getDatabases(),
  storage = getStorage(),
  messaging = getMessaging(),
  audit = recordAudit as (entry: RecordAuditParams) => Promise<void>,
  limit = JOB_QUEUE_DRAIN_LIMIT,
  now = new Date(),
  leaseMs = JOB_LEASE_MS,
}: {
  databases?: sdk.Databases;
  storage?: sdk.Storage;
  messaging?: sdk.Messaging;
  audit?: (entry: RecordAuditParams) => Promise<void>;
  limit?: number;
  now?: Date;
  leaseMs?: number;
} = {}): Promise<JobDrainResult> => {
  const collectionId = env.JOB_QUEUE_COLLECTION_ID;
  const maxAttempts = jobMaxAttempts();

  if (!collectionId) {
    throw new Error(
      "Missing required environment variable JOB_QUEUE_COLLECTION_ID. See .env.example."
    );
  }

  const claimed = await claimDueJobs({ databases, limit, now, leaseMs });
  const ctx: JobHandlerCtx = { databases, storage, messaging, now, audit };
  const results: JobDrainResult = [];

  for (const job of claimed) {
    const handler = handlers.get(job.type);

    if (!handler) {
      const attempts = job.attempts + 1;
      const status = attempts >= maxAttempts ? "failed" : "pending";

      await databases.updateDocument(env.DATABASE_ID, collectionId, job.$id, {
        attempts,
        status,
        claimedAt: "",
        lastError: `No handler registered for job type "${job.type}"`,
        nextAttemptAt: new Date(
          now.getTime() + nextJobRetryDelayMs(attempts)
        ).toISOString(),
      });

      results.push({
        $id: job.$id,
        type: job.type,
        outcome: status === "failed" ? "failed" : "retry",
        attempts,
        result: "",
      });
      continue;
    }

    try {
      const { result = "" } = await handler(job, ctx);

      await databases.updateDocument(env.DATABASE_ID, collectionId, job.$id, {
        status: "done",
        claimedAt: "",
        result,
        completedAt: now.toISOString(),
        lastError: "",
      });

      results.push({
        $id: job.$id,
        type: job.type,
        outcome: "done",
        attempts: job.attempts,
        result,
      });
    } catch (error) {
      const attempts = job.attempts + 1;
      const status = attempts >= maxAttempts ? "failed" : "pending";
      const lastError =
        error instanceof Error ? error.message : String(error);

      await databases.updateDocument(env.DATABASE_ID, collectionId, job.$id, {
        attempts,
        status,
        claimedAt: "",
        lastError,
        nextAttemptAt: new Date(
          now.getTime() + nextJobRetryDelayMs(attempts)
        ).toISOString(),
      });

      results.push({
        $id: job.$id,
        type: job.type,
        outcome: status === "failed" ? "failed" : "retry",
        attempts,
        result: "",
      });
    }
  }

  return results;
};