# ADR-005: Deterministic slot ids make booking a write-once, conflict-free insert

- Status: Accepted
- Date: 2026-10-08

## Context

Two patients can race to book the same physician at the same time. A check-then-
insert ("is this slot free? then create") has a read-then-insert gap: both
requests can read "free", both insert, and the physician is double-booked.
Appwrite offers no compare-and-set or transactions, so there is no obvious
atomic primitive to lean on.

## Decision

Make the appointment document id a pure function of the slot, then let the
database's unique-key behaviour do the serialising
(`src/lib/appointment-slots.ts`):

- `appointmentDocumentId(primaryPhysician, schedule)` =
  `book-<sha256(physician).slice(0,8)>-<epochMilliseconds>`.
- Both concurrent bookings for the same slot compute the *same* id; the second
  `createDocument` fails atomically with a 409, so exactly one insert wins the
  slot. No lock, no transaction.
- `assertNoScheduleConflict` stays as the friendly pre-flight check (so a
  patient sees "pick another slot" instead of a raw 409), but it is no longer
  the thing that guarantees uniqueness — the id is.
- The id respects Appwrite's id length limits; a physician's hash prefix
  prevents near-identical doctor names collapsing onto one id, and epoch ms
  means rebooking a freed slot is a different id.

## Consequences

**Positive.** Double-booking is impossible at the storage layer, not just at the
application layer; the pre-flight check is advisory only; no distributed lock.

**Negative.** The id is derivable (the schedule is visible in the id), which is
fine for an opaque clinical id but means the id should not be treated as a
secret; a slot's id cannot change without changing the slot itself (re-schedule
= delete + rebook, which the UI already models as an update of the document).

## Considered alternatives

**Read-then-insert with a conflict query only.** Rejected (this is the race
being fixed).

**Per-physician named lock / distributed lock.** Rejected: requires a lock
store; the deterministic id gives the same guarantee with zero coordination.