# ADR-001: Appwrite BaaS as the persistence and backend store

- Status: Accepted
- Date: 2026-10-08

## Context

CarePulse stores patient records, PHI-bearing profiles, appointments, an audit
ledger and a notification outbox. It also needs authentication, file uploads,
and SMS delivery. The classic answer — PostgreSQL (or MongoDB, or anything
custom-auth'd) plus a whole application backend — would mean standing up a
database, a migration pipeline, its own auth stack, and a separate API layer.

This project has no separate database server of its own. It is deployed as App
Router server actions and route handlers, and it depends on Appwrite self-hosted
(1.9.x, accessed through `node-appwrite@29`) for everything backend-ish.

## Decision

Use Appwrite Teams/Projects as the backend-of-record: its database (collections
and attributes), users API, storage buckets, and messaging for SMS. All Appwrite
access happens through exactly one thin client (`src/lib/appwrite.config.ts`),
with collection ids, database id and bucket id held as environment-driven
constants.

Schema-at-rest is Appwrite attribute definitions, provisioned idempotently by
`scripts/setup-appwrite.mjs` (safe to re-run; existing resources are skipped).
Queries are written with the typesafe `Query` builders, never string SQL, and
document reads are typed against `src/types/appwrite.types.ts`.

Consequences that follow from this choice are captured in the other ADRs:
field-level encryption instead of database TDE (ADR-003), a transactional outbox
instead of provider-side retries (ADR-004), and a hash-chained audit ledger
because Appwrite offers no append-only or immutable storage (ADR-006).

## Consequences

**Positive.** No database server to operate or migrate by hand; authentication,
file storage and SMS come from the same vendor; provisioning is a script. The
patient is only ever one "server" — Next.js — which keeps the request path short.

**Negative / constraints.**

- Appwrite stores attributes as plaintext, so PHI needs application-layer
  encryption (ADR-003).
- Appwrite has no CAS transactions, so concurrency-safety for slots and for the
  audit chain has to be designed in (ADR-005, ADR-006).
- Anything that needs a custom index or joins beyond Appwrite's query model is
  engineered around (the admin dashboard hydrates relations in batches,
  `src/lib/patient-batch.ts`).
- The deployment is not useable until `setup-appwrite.mjs` has run and the
  printed `.env.local` block is in place.

## Considered alternatives

**PostgreSQL / MongoDB + Prisma-style ORM.** Rejected: it adds a database, a
migration story, its own auth and its own API surface, i.e. the entire stack
Appwrite already supplies. Nothing in the current schema needs SQL-only features
(ad hoc reporting, window functions); the audit ledger's append-only needs are
met with hashing (ADR-006) rather than a trigger-heavy Postgres design.

**Raw HTTP calls to Appwrite REST.** Rejected: loses the typed client, the
`Query` builders, and the single-place client construction.