# ADR-006: Hash-chained, append-only audit ledger for every PHI access

- Status: Accepted
- Date: 2026-10-08

## Context

The app must be able to answer, for any piece of PHI, "who saw what, when, and
from where". Appwrite has no append-only or immutable storage, no triggers, and
no event bus; documents can be updated or deleted by anyone with a console role
or an API key. A plain log collection is not evidence of anything, because a
violator with write access can edit the log itself and cover the trace.

## Decision

Keep every access event in an `audit_log` collection whose *documents* are
linked into a hash chain (`src/lib/audit.ts`):

- Each entry stores `seq`, `ip` (from `x-forwarded-for`/`x-real-ip`, falling back
  to `"unknown"`), `occurredAt`, the acting identity/role/target/action, plus
  two hashes: `hash` = SHA-256 over its own canonical payload field order, and
  `prevHash` = the previous entry's `hash`. The first entry anchors to a fixed
  genesis value.
- `appendAuditEntry` reads the current tail, links, and writes. Because Appwrite
  has no CAS, a concurrent writer can fork the chain by reading the same tail;
  the writer re-reads the tail up to `MAX_LINK_RETRIES` times, re-linking to
  whatever committed in between.
- `verifyAuditChain(entries, anchor?)` replays a dumped ledger and reports the
  first broken link: a tampered field, a deleted entry (seq gap), a reordered or
  duplicated `seq`, or a head that no longer matches a trusted external
  checkpoint.
- Integrity is proven only against a checkpoint stored *outside* the database.
  The operator exports the ledger to write-once storage on a schedule; an
  `anchor` is exactly one such checkpoint. This is how a wholesale rewrite of
  the whole chain is still caught.
- `recordAudit` remains fire-and-forget: an audit failure must never take down
  the operation being audited.
- The collection is provisioned for chain attributes by
  `scripts/setup-appwrite.mjs`, which also upgrades pre-existing ledgers whose
  rows predate the chain (backfilled tails resume at `seq = max+1`).

## Consequences

**Positive.** PHI access is replayable and its integrity checkable without
trusting the person who wrote it; detection covers edits, deletions and
reorderings, not just "who wrote what".

**Negative.** The chain is only as strong as its external checkpoints — this
ADR commits the operator to scheduled exports; concurrent writes can still fork
until the first retry collapse, so a very high-concurrency ledger could leave a
detectable-but-real fork (that is what verification is for). Each write costs a
tail read, so the ledger is not free.

## Considered alternatives

**Database triggers.** Appwrite has none; a trigger on a self-built Postgres
would have reintroduced the database ADR-001 explicitly rejected.

**A separate write-once store as the only audit.** Heavier operationally; the
collection + chain covers the requirement with the app's existing backend and
keeps verification in the codebase.