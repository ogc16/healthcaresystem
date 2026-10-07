# Security Model

Read this before deploying, and in full before handling real patient data.

## Scope and honesty first

**CarePulse is not HIPAA compliant.** No amount of code in this repository makes
it so. HIPAA compliance is a property of an organisation — its policies,
contracts, risk assessments, and incident procedures — not of a Next.js app.

What this page can tell you is which technical controls are genuinely in place
and which are missing. The short version:

| Control | State |
| --- | --- |
| Admin auth moved server-side | **Done** |
| Patient auth with per-user ownership | **Done** |
| Signed, httpOnly, role-scoped sessions | **Done** |
| Upload validation by content signature | **Done** |
| Open-redirect prevention | **Done** |
| Rate limiting on auth, booking, uploads | **Done**, in-process counters only |
| Audit log | **Missing** |
| Field-level encryption of PHI | **Missing** |
| Multi-admin identity | **Missing** (one shared secret) |
| Session revocation before expiry | **Missing** |

Four rows are missing, and the first three are the hard blockers: without an
audit log, without per-admin identity there is nobody to attribute an entry to,
and without encryption the PHI is at rest in plaintext. See
[Roadmap and Open Gaps](Roadmap.md).

## Admin authentication

A shared passkey, verified **server-side only**.

```
Passkey submitted
  → authenticateAdmin  (src/app/admin/actions.ts)
      → throttle per-address, then overall
      → constant-time compare against ADMIN_PASSKEY
      → on success: HMAC-SHA256 signed token in an httpOnly cookie
  → redirect /admin
```

### The cookie

`hcs_admin_session` holds `admin.<payload>.<hmac>`:

| Attribute | Value | Why |
| --- | --- | --- |
| `httpOnly` | `true` | XSS cannot read it |
| `secure` | `true` in production | Not sent over plaintext |
| `sameSite` | `lax` | Plus Next.js server-action origin checks |
| `path` | `/` | |
| `maxAge` | 8 hours | |

`sameSite` is `lax` rather than `strict`. `strict` would be marginally tighter,
but it breaks sign-in if you later add OAuth or cross-domain magic links, since
the cookie is withheld on cross-site navigation. Revisit if neither is added.

### Why it is signed

An unsigned cookie would let a visitor edit the expiry and mint an immortal
session. The signature covers role and payload; verification rejects any mismatch.

### Why the passkey is never in the browser

An earlier version of this app named the variable `NEXT_PUBLIC_ADMIN_PASSKEY`, so
Next.js inlined the passkey into the client bundle, compared it in JavaScript,
and stored it in `localStorage`. Anyone loading the page could read it.

**If your deployment still has `NEXT_PUBLIC_ADMIN_PASSKEY`, remove it.** Use
`ADMIN_PASSKEY`.

### Rate limiting

Guessing a shared secret is only slow if attempts are throttled. The primitive is
`createRateLimiter` in `src/lib/auth/rate-limit.ts`; `src/lib/auth/throttle.ts`
composes it into a per-subject allowance plus a global ceiling, which is what
every throttled action uses:

| Action | Per subject | Ceiling | Window |
| --- | --- | --- | --- |
| Admin sign-in | 5 per address | 50 | 15 min |
| Patient sign-in | 10 per address **and** per email | 100 | 15 min |
| Account creation | 5 per address | 50 | 1 hour |
| Patient registration | 5 per patient | 100 | 1 hour |
| Appointment booking | 10 per acting identity | 200 | 1 hour |

The overall ceiling is the one that actually holds. `x-forwarded-for` is
client-controlled on any deployment not behind a proxy that rewrites it, so the
per-address limit alone can be sidestepped by rotating the header. Subject tiers
are consumed **first**, so a caller who is already locked out cannot burn the
global budget and lock everyone else out. That ordering is asserted in
`throttle.test.ts`, because reversing it is a cross-user denial of service.

Session-backed actions key on the signed user id instead of the address. A
hospital network or a mobile carrier behind CGNAT shares one address among many
unrelated patients, so an address key there would throttle strangers together.

### Why patient sign-in checks two subjects

Both have a hole on their own:

- **Address only** — a botnet has plenty of addresses.
- **Email only** — the owner of that address could be locked out of their own
  account by a handful of doomed attempts, turning a defence into a denial-of-
  service lever.

Together they cover both. The email tier slows targeted guessing, the address
tier plus the ceiling binds someone rotating one or the other, and the
15-minute window keeps that lockout lever short. Both tiers share **one** global
slot per attempt; charging each separately would silently halve the ceiling.

The email is lowercased, so `Alice@example.com` and `alice@example.com` draw
from the same bucket rather than each getting their own allowance.

A patient password is a far larger search space than the six-digit admin
passkey, so ten guesses per address and per email remains impractical to guess
while leaving headroom for someone who mistypes a few times.

### Placement

- **Registration is throttled before the upload.** The upload is the expensive
  part, storage is billed per GB, and a file that passes validation still costs
  real bytes. Checking afterwards would leave the cost unmetered.
- **Booking is keyed on the acting identity.** An admin booking on a patient's
  behalf is charged to the admin, not to the patient who did nothing.
- **Sign-in is throttled before the upstream call**, so a refused caller cannot
  use Appwrite as an unlimited guessing oracle, but after parsing, so a
  malformed payload does not spend an attempt.

Design details that are deliberate, and easy to undo by accident:

- The passkey is compared only after the throttle passes, so a locked-out caller
  cannot use response timing as an oracle.
- A successful login clears every key it checked, so someone who fumbles a few
  times is not locked out for the rest of the window. The global ceiling is not
  reset — it is a volume guard, not a per-user budget.
- **Refused attempts do not extend the window.** Otherwise hammering during a
  lockout turns a 15-minute delay into a permanent ban.

### Its limitation

The limiter is **in process memory**: per Node instance, reset on restart. It
makes online guessing tedious against a single instance. It is not a shared
store, so with more than one replica each keeps its own counters, and a restart
resets them. `RateLimiter` is an interface, so swapping in Redis or
`@upstash/ratelimit` is a local change.

## Patient authentication

Appwrite verifies credentials; this app never stores or compares them.

```
Sign up (/)
  → createPatientAccount
      → Zod validation, server-side
      → users.create(email, phone, password, name)
      → 409 on an existing email → "sign in instead", never a silent fallback
      → account.createEmailPasswordSession

Sign in (/login) → loginPatient → signed cookie hcs_patient_session

Any /patients/* → proxy verifies the signature → page and action guards re-check
```

The cookie carries `{ exp, uid, sid }`. `uid` is the Appwrite user id and is the
**only** source of identity — no route accepts a user id. `sid` is the upstream
session id, so logout revokes the session in Appwrite rather than only dropping
the local cookie.

### Credentials are verified in Appwrite, not here

The `account` client is built **without the API key**. This is the security
boundary of the sign-in flow: if the admin key were attached, every login would
be an admin lookup.

### Ownership is enforced in the action layer

`assertCanActForPatient` admits an admin acting for anyone, and a patient only
for themselves. The check runs against the **stored** record, not the submitted
payload — otherwise a caller could assert ownership.

Because server actions are endpoints, this matters more than it looks:

| Helper | Was | Now |
| --- | --- | --- |
| `sendSMSNotification(...)` | Exported. Anyone could post an arbitrary `userId` and `content` and have the app send SMS — a messaging-abuse and cost vector | Module-private. Only `updateAppointment` may send, and only to the stored owner |
| `createUser(...)` | Exported. Reachable directly, skipping schema validation and returning the full user record | Module-private to `createPatientAccount` |
| `registerPatient(...)` | Accepted a caller-supplied `userId` | Overwritten with the session's, so a supplied id cannot win |
| `getPatient(userId)` / `getUser(userId)` | Read any patient's record or account by id | No parameter; always the session user |

SMS recipients come from the stored appointment owner, never from the request, so
a reminder cannot be redirected to an arbitrary number.

### Post-sign-in redirects

`redirect()` accepts absolute URLs, so an unvalidated `from` would be an open
redirect. `safeReturnPath` (`src/lib/auth/return-path.ts`) honours only local
`/patients/` paths: single leading slash, no `..`, no backslash, no newline.
`/patients/../admin` normalises to `/admin` before the browser requests it, so a
prefix check alone is not enough.

## Upload validation

Identification documents are attacker-controlled binaries in a shared bucket.
`src/lib/uploads.ts` validates inside `registerPatient`, **before** the file
reaches Appwrite:

| Check | Rule |
| --- | --- |
| Extension | `.pdf`, `.jpg`, `.jpeg`, `.png` |
| Size | 1 byte – 3 MB |
| Content | Magic-byte signature must match the extension |

The signature test is load-bearing. `blob.type` is whatever the client claims, and
a `.jpg` extension proves nothing about the bytes. `detectMimeType` reads the
first 12 bytes.

Extensions bind to exactly one content type rather than checking two independent
allowlists. Without that binding, a real PDF named `id.png` satisfies both lists
and is stored and served under an image name — content-type confusion in the
browser and in Appwrite's CDN.

`FileUploader.tsx` applies the same limits client-side for convenience only. The
server check is the one that holds.

> The bucket's visibility is Appwrite-side configuration. Confirm it in the
> console before storing identity documents.

## Booking integrity

`createAppointment` and scheduling `updateAppointment` call
`assertNoScheduleConflict`. A doctor is double-booked when a non-cancelled
appointment starts within `APPOINTMENT_DURATION_MINUTES` (30) either side of the
requested time. Cancelled appointments release their slot.

Appwrite's `Query.between` is inclusive on both bounds, so it is only a
±30-minute pre-filter; the exact overlap test runs in JS.

**This check is race-prone.** Two concurrent requests can both pass before either
is written. Closing it needs an Appwrite unique compound index on
`(primaryPhysician, schedule)`, which rejects the duplicate at write time.

## Known gaps

Detailed in [Roadmap and Open Gaps](Roadmap.md). In brief:

1. **No audit log.** Nothing records who viewed or modified a record. Required
   before real PHI.
2. **One shared admin passkey.** No per-admin identity, so actions cannot be
   attributed to a person.
3. **No field-level encryption.** See the Roadmap for why encrypting identifiers
   conflicts with document-level permissions and indexes.
4. **Session revocation is not immediate.** A stolen cookie is accepted until its
   8-hour expiry. The proxy and guards check the signature and expiry but do not
   ask Appwrite whether the session is still live.
5. **Rate-limit counters are in-process.** Every endpoint above is throttled,
   but the counters live in each Node process: reset on restart, and one per
   replica on a multi-node deployment. Fine on a single instance, not a control
   worth relying on at scale.
6. **`timeZone` is client-asserted.** Validated as a real IANA zone, but it still
   originates in the browser. It only formats the SMS reminder, so it is
   cosmetic and must never gate anything security-relevant.

## Reporting a vulnerability

Do not open a public issue. Report it privately to the maintainers.