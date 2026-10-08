# ADR-007: Every mutation is a `"use server"` action; the database is never written by the client

- Status: Accepted
- Date: 2026-10-08

## Context

The client (React UI) and the backend (Appwrite) are different trust domains.
If the browser could write to Appwrite directly, every validation, ownership
rule, permission and audit hook in `src/lib/` would be bypassable by anyone who
opens the network tab. Server-rendered pages and POST-only handlers already keep
most paths server-side, but the boundary must be explicit for every write, and
every write action must apply the same gauntlet: **validate → authorise → check
rates → mutate → audit**.

## Decision

All mutations (sign-up, sign-in, patient create/update, appointment
create/update/cancel, admin scheduling) are `"use server"` (or `"use client"`
wrappers that invoke a server action) in `src/lib/actions/`. The Appwrite
client used by actions is server-only (`src/lib/appwrite.config.ts`); the
browser never holds an API key or a write-capable Appwrite session. The cron and
document route handlers are thin HTTP layers over the same action modules.

Every mutation route goes through the same ordered gates:

1. **`src/lib/validation.ts`** — zod schema (server side, never shared client
   raw); invalid input fails before touching Appwrite.
2. **`src/lib/auth/guards.ts`** — session resolved from signed cookies;
   `requirePatient`/`isAdminSession`/`assertCanActForPatient` enforce role and
   that a patient only touches their own record.
3. **`src/lib/auth/throttle.ts`** — two-tier rate limiting (per-subject + global
   ceiling) for unauthenticated and rate-sensitive paths.
4. Mutation — through the typed `node-appwrite` SDK only.
5. **`src/lib/audit.ts`** — every PHI read/create/update/list is recorded into
   the hash-chained ledger (ADR-006).

## Consequences

**Positive.** Every write is (a) validated, (b) authorised, (c) rate-limited,
(d) audited, in one place per action; the client has no write path to the data;
the e2e mock is safe because all real traffic looks like HTTP actions.

**Negative.** Server actions are the single transport, so anything the UI
cannot express as a server action needs a route handler or form post; action
code must stay server-only (no client imports of `next/headers`, crypto, or the
Appwrite client).

## Considered alternatives

**Direct Appwrite SDK calls from the client with client-side rules.** Rejected:
would hand the validation/authorisation/audit gauntlet to the least trusted
layer.

**A separate REST/remote-procedure backend.** Rejected as redundant — the App
Router already provides the server boundary; a second network service would only
add a hop (see ADR-001).