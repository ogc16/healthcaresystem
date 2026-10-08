# ADR-008: Persistent job queue for background work

- Status: accepted
- Date: 2026-10-08
- Depends on: [ADR-004 (SMS outbox)](ADR-004-sms-outbox.md), [ADR-006 (audit ledger)](ADR-006-tamper-evident-audit-trail.md)

## Context

Two pieces of work are too slow or too heavy to run inside the request that
creates them:

- **PDF invoices**: generating a document, uploading it to storage, auditing
  the creation, and notifying the patient.
- **Appointment reminders**: scanning for due appointments and fanning out an
  SMS per patient.

Running them inline couples booking latency to external dependency latency and
means a failure anywhere in the chain fails the booking. We already solved the
distribution half of this problem for SMS with the durable outbox
([ADR-004](ADR-004-sms-outbox.md)); invoices and reminder dispatch need the
same guarantee for *computation*, not just delivery.

## Decision

Add a general-purpose, persistent, type-tagged job queue stored in Appwrite:

- A single `job_queue` collection. Each row is `type` (a stable string like
  `invoice.generate`), `payload` (JSON text), `status` (pending / processing /
  done / failed), `attempts`, `nextAttemptAt`, and `claimedAt`.
- Jobs are **enqueued with `enqueueJob`** from the request path, best-effort:
  a down queue logs and continues, never failing the caller.
- A scheduled drain (`GET /api/cron/jobs`, guarded by the same `CRON_SECRET`
  checks as the SMS cron) claims due jobs and runs each through its registered
  handler.
- **Claiming is optimistic.** A row is stamped `processing` with a `claimedAt`
  lease before its handler runs; a later drain requeues rows whose lease
  expired, so a crash mid-run cannot strand a job. Appwrite has no
  compare-and-set, so two concurrent drains can race the same row; the queue is
  normally drained by a single cron, and handlers are written to tolerate a
  duplicate (at-least-once).
- **Retries use the same capped exponential backoff as the outbox**, with an
  attempt cap (`JOB_MAX_ATTEMPTS`, default 5). A job with no registered
  handler is marked failed with a readable reason rather than silently lost.
- Handlers **register a job type once** (`registerJobHandler`); the list lives
  in `src/lib/jobs/index.ts`.

Two handlers ship with it:

1. `invoice.generate` — builds a PDF with a dependency-free writer (no PDF
   library, just a text stream + xref, so there is no native-dependency risk),
   uploads it to the document bucket, records `document.create` in the audit
   ledger, and enqueues a de-duplicated notification SMS. Booking enqueues it
   with the deterministic id `invoice-<appointmentId>`, so an appointment
   gets exactly one invoice even if it is re-confirmed.
2. `reminder.dispatch` — the cron enqueues this once per day under a
   deterministic day-scoped id; when drained it scans for `scheduled`
   appointments in the next 24h and writes one `sms_outbox` row per patient,
   each carrying a `reminder:<appointmentId>:<day>` `dedupeKey`. The outbox
   (already retried by ADR-004) owns delivery.

## Consequences

- Invoice generation and reminder fan-out no longer block request handlers.
- Failure is observable: a job ends `failed` with `lastError`, or retries with
  a visible `nextAttemptAt`.
- Every heavy step can be re-run without inventing ad hoc tooling: push the
  job row back to `pending` and drain again.
- We add two string-datetime knobs (`claimedAt`, `completedAt`), a `dedupeKey`
  attribute on the outbox (so reminders and invoice notices are at-most-once),
  and two environment variables (`JOB_QUEUE_COLLECTION_ID`,
  `JOB_MAX_ATTEMPTS`).
- A buggy handler that throws is retried with backoff rather than surfacing to
  a user, so operator attention is still required — the job queue moves, it
  does not hide, the failure.