# Roadmap and Open Gaps

An honest inventory of what is unfinished, what is blocked, and what is not worth
building as originally proposed.

## Done recently

| Change | Notes |
| --- | --- |
| Admin dashboard crash fix | `getRecentAppointmentList` returned `undefined`, so `admin/page.tsx` read a property off it and threw a `TypeError`. Now returns an empty result |
| `next-themes` removed | It injected `class` and `color-scheme` on `<html>` from `localStorage`, causing a hydration mismatch. Nothing consumed the class: no `.light`/`.dark` rules, no `dark:` variants, no `useTheme` calls |
| Admin sign-in no longer throws | An uncaught error in a server action tears down the page to the global error boundary and leaked the missing variable name to the browser. Now returns a form error |
| Rate limiting on admin sign-in | 5/address and 50 overall per 15 minutes, with tests |
| Rate limiting on booking and registration | Shared throttle helper; booking, registration, and account creation all bounded. Registration is metered before the upload |
| Sentry no longer reports to a third party | The committed upstream DSN is gone from all three configs. Reporting is off unless `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` are set |
| Configuration reported explicitly | Missing variables are named on the dashboard instead of rendering zeroes |
| CI workflow | typecheck, lint, test, build on every push |
| 96 unit tests | Security invariants: sessions, redirects, uploads, booking conflicts, rate limits, throttle ordering, config |

## Blocking deployment with real patient data

### 1. No audit log

Nothing records who viewed or modified a record. Patient identity now exists, so
there is something to log, but nothing does. Under HIPAA's access and activity
requirements this is the first thing that must exist.

Needs: an append-only log of actor, action, subject, and timestamp. Write it from
the action layer so it cannot be bypassed by a page that forgets to call it.

### 2. No field-level encryption

This is the item most likely to be built wrong, so the reasoning is recorded here.

The naive plan — AES-256-GCM on `patientId`, national ID, phone, and notes —
**conflicts with two other requirements in the same brief.**

Appwrite evaluates document-level permissions by matching attribute values, and
builds indexes the same way. Ciphertext does not match anything.

| Requirement | Encrypts `patientId`? |
| --- | --- |
| Patients read only their own appointments | **Broken.** The permission filter cannot match an encrypted attribute |
| Index on `patientId` | **Impossible.** You cannot index opaque ciphertext for equality |
| Encrypt the national ID | Works, if nothing needs to query or filter on it |

So the three cannot all hold. The workable design:

- **Encrypt free-text PHI** — medical history notes, prescription notes. These
  are never queried, only displayed.
- **Leave joinable identifiers in clear** — Appwrite user ID, status, timestamps.
  These are what permissions and indexes operate on.
- **If a field must be both encrypted and searchable**, store an HMAC blind
  index beside the ciphertext: `HMAC-SHA256(value, searchKey)`. Deterministic, so
  equality queries still work, without revealing the plaintext to someone who
  only reads the database.

**Key management is the harder half.** A single AES key in an environment variable
means no rotation without re-encrypting every record, and one leaked env dump
decrypts everything. If app-level encryption is done at all, it should be
envelope encryption: a random data key per record, wrapped by a master key. Then
rotation is a re-wrap rather than a rewrite.

Also worth knowing: Appwrite offers server-side encryption at rest for databases
and buckets. That is complementary to, not a substitute for, field-level
encryption — it does not help against anyone who can query the collection.

### 3. Shared admin passkey

One value for all admins. Actions cannot be attributed to a person, which is an
audit problem as much as an authentication one.

Fixing it properly means per-admin credentials with a real user store, and the
audit log from item 1. This is the largest single piece of work here.

### 4. Session revocation is not immediate

`logoutPatient` revokes the session upstream, but the proxy and guards check only
the local signature and expiry. A stolen cookie is accepted until its 8-hour
expiry. Options: shorten the TTL, or check Appwrite per request — the latter
costs a round trip on every request.

## Reliability

### SMS delivery blocks booking

`createAppointment` sends confirmation SMS inline. If Twilio is slow or down, the
patient's booking request hangs or fails after the record was already written.

Needs a queue with retry and backoff.

**Deployment target determines the implementation:**

| Target | Use |
| --- | --- |
| Vercel or other serverless | QStash, or Upstash Redis + a triggered consumer |
| A long-running Node host | BullMQ |

BullMQ needs a persistent Redis *and* a worker process that stays alive. It does
not run on serverless. Do not build BullMQ for a Vercel deployment.

### Rate limiting is in-process, and patient sign-in has none

Booking, registration, and account creation are throttled, via
`src/lib/auth/throttle.ts`, which composes a per-subject allowance with a global
ceiling. Two things are still open:

- The counters are **in process memory**: per Node instance, reset on restart. On
  more than one replica each keeps its own. This is the whole reason the limiter
  is behind a small interface — swap in Redis or `@upstash/ratelimit` and no call
  site changes.
- **Patient sign-in is unthrottled** at the application layer. Account creation
  is now limited, which closes the cheaper abuse path, but sign-in against a
  known email still gets only Appwrite's own protections. This is the next one to
  close, and it is the same shape as the rest.

### Multi-step registration loses progress on refresh

Registration is a multi-step form. A refresh mid-flow discards everything. Fix:
persist form state to IndexedDB or `localStorage` and restore on mount. `localStorage`
is the right call here unless the forms grow large enough to matter.

## Testing

### No end-to-end suite

There is no Playwright coverage of the critical paths: onboarding, booking,
status changes, admin authentication, cancellation.

This was left undone rather than half-done, because the critical paths all need a
live Appwrite database. A suite against mocks would pass while the real flows
broke, which is worse than no suite because it manufactures confidence.

Worth writing once credentials exist.

### Race conditions in booking

The double-booking check is inherently racy: two concurrent requests can both pass
before either is written.

The fix is an Appwrite unique compound index on `(primaryPhysician, schedule)`,
which rejects the duplicate at write time instead. Configure it, then catch the
conflict and surface it as a scheduling error.

## Product features

None of these are started. Listed with the engineering reality attached, because
several are larger than they look.

| Feature | Reality |
| --- | --- |
| iCal / Google Calendar | The `.ics` generation is straightforward and self-contained — a good first feature. "Send via email" needs an email provider this project does not currently have; SMS is available through Appwrite Messaging |
| Patient medical timeline | Mostly a read view over existing data. The interesting question is what a patient is permitted to see of a clinician's notes, which is a policy decision, not a coding one |
| Automated SMS reminders | Needs the queue from above, plus a scheduler. Vercel Cron or a GitHub Actions schedule; GitHub Actions is free but has no guarantee of firing on time, which matters for a 24-hour reminder |
| PDF reports | `@react-pdf/renderer` works in the App Router only as a client component or behind a dynamic import. Prefer a route handler that streams the PDF |

## Housekeeping

- **The old Sentry DSN is in git history.** The configs now read
  `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` and report nothing when unset, but the
  upstream DSN remains in the history of this repository. Rotating that project
  upstream is the only way to revoke it for anyone who cloned an earlier commit.
- **`next lint` is deprecated.** The `lint` script runs `eslint` directly, which
  is correct for Next 16.
- **9 high-severity dev-only advisories** via `braces@3.0.3`, reachable only
  through Tailwind's toolchain. No patched `braces` 3 release exists; resolution
  requires the breaking Tailwind 4 migration.
- **`clientTraceMetadata` experimental flag** enabled in `next.config.mjs`. It is
  an experiment, not a requirement.
- **MIT attribution unresolved.** Upstream returns 404, so the required
  attribution cannot be confirmed.
- **`v0.3.0` tag predates the CI and security work** and does not contain it.

## Suggested order

1. Audit log — unblocks compliance and makes the next item possible.
2. Per-admin identity — replaces the shared passkey.
3. Shared-store rate limiting, replacing the in-process counters.
4. SMS queue, matched to the deployment target.
5. Field-level encryption, free-text first, with envelope encryption.
6. E2E suite, once credentials exist.

Items 1 and 2 are the ones that matter. The rest are quality-of-life in
comparison, and none of them make real PHI safe on their own.