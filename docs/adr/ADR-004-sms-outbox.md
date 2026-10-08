# ADR-004: Transactional SMS outbox with capped backoff, drained by a protected cron

- Status: Accepted
- Date: 2026-10-08

## Context

Booking state changes must notify patients (confirmation, scheduling update,
cancellation). Sending SMS inline on the same request that mutates the
appointment has two failure modes: the provider call is slow or throws after the
appointment write commits (the patient never learns), and a retry of the client-
visible action would re-send stale messages. The app also cannot give up after
one provider error — delivery must be retried with backoff and eventually
marked failed.

## Decision

Give every notification a row in an `sms_outbox` collection (`status`, `attempts`,
`nextAttemptAt`, `lastError`) written in the same server action that makes the
state change (`enqueueSms`) — the outbox-as-transaction pattern — and let a
scheduled drain (`/api/cron/sms`) deliver it (`drainSmsOutbox`):

- The enqueue is best-effort like `recordAudit`: a failing provider must never
  take the booking update that produced the notification down with it.
- The drain fetches the oldest `pending` messages whose `nextAttemptAt` has
  elapsed, sends via Appwrite messaging, and on success marks the message
  `sent`; on failure it records `attempts`, stamps the next retry with capped
  exponential backoff (`15s * 2^(attempt-1)`, cap 24h) and flips to `failed` at
  `SMS_MAX_ATTEMPTS`.
- The cron route is protected by `CRON_SECRET` (exact-match header check) so a
  public internet caller cannot drain or spam the outbox.
- Delivery is **at-least-once**: a crash between send and the status write can
  re-send. That is the accepted trade — a duplicate SMS is an annoyance, a lost
  confirmation is a missed appointment.
- The retry schedule and drain limit are env-tunable
  (`SMS_MAX_ATTEMPTS`, `SMS_OUTBOX_COLLECTION_ID`, drain limit constant).

## Consequences

**Positive.** Notifications survive provider outages; state-change latency never
depends on the provider; every message has an audit-able lifecycle
(pending/sent/failed + attempts + lastError).

**Negative.** Up to one duplicate on crash; the outbox table must be drained on
a schedule (a cron trigger the deployment must ensure fires); the provider call
runs inside the same process that hosts the cron route.

## Considered alternatives

**Inline send with retries at the call site.** Rejected: couples request latency
and reliability to the SMS provider, and retry semantics on the client-facing
action are ambiguous.

**Queue service (BullMQ/Celery/RabbitMQ).** Rejected for now: it is a second
state store and a second deployment concern for the same at-least-once + backoff
behaviour. The outbox collection *is* the queue; if a generalised job queue is
adopted later it should sit on the same collection shape (see ADR-008).

## Considered later (ADR-008)

The outbox is deliberately a general "job" row: `userId`, payload, status,
retry bookkeeping. Extending it to non-SMS work (appointment reminders that
fan out to several recipients, generated PDF invoices) is an additive change to
the collection's `content`/`jobType` fields, not a new piece of infrastructure.