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
| Admin sign-in rate limiting | **Done**, in-process only |
| Audit log | **Missing** |
| Field-level encryption of PHI | **Missing** |
| Multi-admin identity | **Missing** (one shared secret) |
| Session revocation before expiry | **Missing** |

The three missing items are why this must not hold real PHI yet. See
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

Guessing a shared secret is only slow if attempts are throttled. The limiter is
in `src/lib/auth/rate-limit.ts`, counted twice:

| Limiter | Limit | Window |
| --- | --- | --- |
| Per address | 5 | 15 minutes |
| Overall | 50 | 15 minutes |

The overall ceiling is the one that actually holds. `x-forwarded-for` is
client-controlled on any deployment not behind a proxy that rewrites it, so the
per-address limit alone can be sidestepped by rotating the header. Per-address is
consumed **first**, so a caller who is already locked out cannot burn the global
budget and lock everyone else out.

Design details that are deliberate, and easy to undo by accident:

- The passkey is compared only after both throttles pass, so a locked-out caller
  cannot use response timing as an oracle.
- A successful login clears that address, so someone who fumbles a few times is
  not locked out for the rest of the window. The global ceiling is not reset.
- **Refused attempts do not extend the window.** Otherwise hammering during a
  lockout turns a 15-minute delay into a permanent ban.

### Its limitation

The limiter is **in process memory**: per Node instance, reset on restart. It
makes online guessing tedious against a single instance. It is not a shared
store, so with more than one replica each keeps its own counters, and a restart
resets them. `RateLimiter` is an interface, so swapping in Redis or
`@upstash/ratelimit` is a local change.

The public booking and registration endpoints are **not** throttled. See the
Roadmap.

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
5. **Booking and registration are unthrottled.** Authenticated, but unbounded —
   they can exhaust the messaging quota or fill the storage bucket.
6. **`timeZone` is client-asserted.** Validated as a real IANA zone, but it still
   originates in the browser. It only formats the SMS reminder, so it is
   cosmetic and must never gate anything security-relevant.

## Reporting a vulnerability

Do not open a public issue. Report it privately to the maintainers.