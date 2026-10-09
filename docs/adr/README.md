# Architecture Decision Records (ADR)

Architecture decisions for CarePulse, one record per decision, in the order the
decision was locked in. A new record is added when a decision changes the
architecture — not when an implementation detail changes. Records are immutable;
a superseding decision is recorded as a new ADR that references the old one.

| ADR | Decision | Status |
| --- | --- | --- |
| [ADR-001](ADR-001-storage-with-appwrite.md) | Appwrite BaaS as the persistence and backend store | Accepted |
| [ADR-002](ADR-002-session-cookies.md) | Self-signed HMAC session cookies, not JWT | Accepted |
| [ADR-003](ADR-003-phi-field-encryption.md) | AES-256-GCM application-layer encryption for PHI at rest | Accepted |
| [ADR-004](ADR-004-sms-outbox.md) | Transactional SMS outbox with capped backoff, drained by a protected cron | Accepted |
| [ADR-005](ADR-005-appointment-scheduling.md) | Deterministic slot ids make booking a write-once, conflict-free insert | Accepted |
| [ADR-006](ADR-006-tamper-evident-audit-trail.md) | Hash-chained, append-only audit ledger for every PHI access | Accepted |
| [ADR-007](ADR-007-server-actions-interface.md) | Every mutation is a `"use server"` action; the database is never written by the client | Accepted |
| [ADR-008](ADR-008-job-queue.md) | Persistent, type-tagged job queue drains PDF invoices and reminders on a protected cron | Accepted |
| [ADR-009](ADR-009-admin-telemetry.md) | Live admin telemetry pushed to the dashboard over Server-Sent Events | Accepted |

Records follow the MADR/Classic ADR shape: Context, Decision, Consequences.