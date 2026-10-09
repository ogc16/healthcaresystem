# ADR-009: Live admin telemetry over Server-Sent Events

- Status: accepted
- Date: 2026-10-08
- Depends on: [ADR-006 (audit ledger)](ADR-006-tamper-evident-audit-trail.md)

## Context

The admin dashboard can only observe what it polls. To see "is the system
actually doing anything right now" — an appointment was scheduled, a document
was read, a queue job completed — an operator has to reload a page. The system
already records every interesting moment in the tamper-evident audit ledger
([ADR-006](ADR-006-tamper-evident-audit-trail.md)); what is missing is a way to
watch the ledger live.

Real-time options considered:

- **WebSockets** — full-duplex and well-supported, but there is no websocket
  server in the deployment today, and the admin dashboard only ever *listens*.
- **Polling** — simplest, but adds latency and load without ever being truly
  live.
- **Server-Sent Events (SSE)** — one-way push over plain HTTP, served by a
  normal Next.js route, authenticated by the existing session cookie, and
  consumed by a browser `EventSource` with no client dependency.

## Decision

Expose `GET /api/admin/telemetry` as an SSE stream, guarded by the same admin
session check as the dashboard pages:

- The server sends a `ready` event **only after** it has registered its
  subscription, so a client that has seen `ready` is guaranteed not to miss
  events.
- Every committed audit-ledger entry is broadcast as an `audit.entry` event.
  "Committed" matters: `appendAuditEntry` publishes the entry the moment the
  durable write succeeds, so a retried or failed write is never shown as if it
  existed.
- A comment heartbeat (`: ping`) every 15s keeps intermediaries from killing
  the idle connection; the dashboard can also use it to detect a dead stream.
- Delivery is **in-process, best-effort, and ephemeral**: a small pub/sub hub
  (`src/lib/telemetry.ts`) notifies subscribed listeners synchronously, one
  throwing listener cannot break the rest, and the hub caps subscriptions so a
  pile-up of abandoned tabs cannot exhaust memory. There is no replay and no
  persistence — telemetry is a live window onto the ledger, never a
  replacement for it.

## Consequences

- The dashboard can show live activity without a dependency, a socket server,
  or any new infra.
- The stream is **per-instance**: in a multi-replica deployment each replica
  broadcasts only its own writes. For a single-instance self-host, that is the
  whole truth; the note is recorded here so a future horizontal scaling effort
  knows to revisit it.
- Older events are not replayed. Anything an operator needs after the fact
  comes from the ledger itself.
- The event payload is deliberately PHI-free: it carries the same projection
  the operator console already shows (seq, action, actor, resource, timestamp),
  never record bodies, so the SSE stream is safe behind the admin session given
  the session itself is already the PHI boundary.
- The route replaces polling for the activity view, but polling-heavy queries
  elsewhere are untouched and future suspects (the bus is not a cache).