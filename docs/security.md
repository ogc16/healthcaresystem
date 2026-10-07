# Security

## Admin authentication

### Model

Admin access is a shared 6-digit passkey, verified **server-side** only.

```
Passkey submitted
  → src/app/admin/actions.ts :: authenticateAdmin
      → constant-time compare against ADMIN_PASSKEY (server-only env var)
      → on success: HMAC-SHA256 signed token in an httpOnly cookie
  → redirect /admin
```

Cookie `hcs_admin_session` holds `admin.<payload>.<hmac>` and is set with:

| Attribute | Value |
| --- | --- |
| `httpOnly` | `true` — unreachable from JS, so XSS cannot read it |
| `secure` | `true` in production |
| `sameSite` | `lax` — plus Next.js server-action origin checks |
| `path` | `/` |
| `maxAge` | 8 hours |

The HMAC is keyed by `SESSION_SECRET`. Rotating that secret invalidates every
active session, admin and patient alike.

### Why the token is signed

An unsigned cookie would let a visitor edit `expiresAt` and mint an immortal
session. The signature covers the role *and* the payload, and verification
rejects any token whose signature doesn't match. Session logic lives in
`src/lib/auth/session.ts` and is deliberately free of `node:crypto` and
`next/headers` so it runs in the Node.js runtime that Proxy and Server Components share.

### What was fixed

The previous implementation had no server-side gate at all:

- `ADMIN_PASSKEY` was `NEXT_PUBLIC_ADMIN_PASSKEY`, so Next.js inlined it into
  the client bundle — the passkey was readable by anyone who loaded the page.
- `PasskeyModal.tsx` compared the passkey in the browser and stored it in
  `localStorage`.
- `encryptKey`/`decryptKey` were `btoa`/`atob` — base64, not encryption.
- `src/app/admin/page.tsx` had no guard; visiting `/admin` returned every
  appointment in the database.

> **Deployment note:** remove `NEXT_PUBLIC_ADMIN_PASSKEY` from your hosting
> environment. Set `ADMIN_PASSKEY` and `SESSION_SECRET` instead.

## Patient authentication

### Model

Patients sign in with an email and password. Appwrite verifies the credential;
this app never stores or compares it.

```
Signup (/)
  → createPatientAccount  (src/lib/actions/auth.actions.ts)
      → PatientAccountSchema validation, server-side
      → users.create(email, phone, password, name)
      → 409 on an existing email → "sign in instead", never a fallback sign-in
      → account.createEmailPasswordSession(email, password)

Sign in (/login)
  → loginPatient
      → LoginSchema validation, server-side
      → account.createEmailPasswordSession(email, password)
      → signed cookie hcs_patient_session = patient.<payload>.<hmac>

Any /patients/* request
  → proxy verifies the signature, redirects to /login?from=<path>
  → page guard + action guard re-check server-side
```

The cookie carries `{ exp, uid, sid }`. `uid` is the Appwrite user id and is the
only source of identity in the patient portal — no route accepts a user id, so
there is nothing for a caller to tamper with. `sid` is the upstream Appwrite
session id, so `logoutPatient` revokes the session in Appwrite
(`users.deleteSession`) instead of only discarding the local cookie.

Cookie attributes are identical to the admin cookie: `httpOnly`, `secure` in
production, `sameSite: "lax"`, `path: "/"`, `maxAge` 8 hours.

### Credentials are verified in Appwrite, not here

The `account` client in `src/lib/appwrite.config.ts` is built **without the API
key**. `account.createEmailPasswordSession` is the public sign-in endpoint, so
keeping the admin key off it means Appwrite — not this app — decides whether the
supplied credentials are correct.

The trap this avoids: `users.createSession(userId)` mints a valid session for any
user straight from the API key, with no password check whatsoever. It is a
server-side impersonation helper and is not a sign-in path. It is not used
anywhere in this codebase.

### Route and action enforcement

The `[userId]` route segment is gone. `/patients/*` routes take no identity
parameter:

| Route | Identity source |
| --- | --- |
| `/patients/register` | Session `uid` |
| `/patients/new-appointment` | Session `uid` |
| `/patients/new-appointment/success` | Session `uid` + appointment ownership |

Ownership is enforced in the action layer by `assertCanActForPatient`, which
admits an admin acting for anyone and a patient only for themselves:

| Action | Rule |
| --- | --- |
| `getPatient()` | Reads the session user's own record. No `userId` parameter. |
| `getUser()` | Reads the session user's own Appwrite account. No `userId` parameter. |
| `sendSMSNotification(...)` | Was exported, so anyone could post an arbitrary `userId` and `content` and have the app send SMS — a messaging-abuse and cost vector that bypassed the ownership checks entirely. Now module-private; only `updateAppointment` may send, and only to the stored owner. |
| `createUser(...)` | Was exported, so account creation was reachable directly, skipping server-side schema validation and returning the full user record. Now module-private to `createPatientAccount`. |
| `registerPatient(...)` | `userId` is spread in from the payload and then overwritten with the session's, so a caller-supplied id cannot win. |
| `createAppointment(...)` | Patient identity is the session; admins may book for anyone. |
| `getAppointment(id)` | Requires `appointment.userId === session.userId`, or an admin session. |
| `updateAppointment(...)` | Same ownership check, against the **stored** record rather than the payload. |

Because these are `"use server"` exports, each is a network endpoint, and payload
validation is not a trust boundary. Account creation and sign-in parse their
input with Zod on the server, and `getUser`/`getPatient` derive identity from the
session instead of accepting one.

That same reasoning applies to what is *not* exported: two helpers were reachable
as endpoints even though nothing outside their own flow should call them, and
both have been made module-private. Audit new `"use server"` exports for the same
property — a helper that only exists to serve one caller should not be a public
endpoint.

SMS recipients come from the stored appointment owner, not from the request, so a
caller cannot redirect a reminder to an arbitrary phone number.

### Post-sign-in redirects

Both the login page and the `loginPatient` action pass the target through
`safeReturnPath` (`src/lib/auth/return-path.ts`). `redirect()` accepts absolute
URLs, so an unvalidated `from` would be an open redirect. Only local
`/patients/` paths are honoured: single leading slash, no `..` segment, no
backslash, no newline. `/patients/../admin` normalises to `/admin` before the
browser requests it, so the prefix check on its own is not sufficient.

### Existing accounts have no password

Accounts created before this change were passwordless — the old `/` form only
collected a name, email and phone. They cannot sign in, because
`createEmailPasswordSession` has no password to check, and re-registering the
same email returns the duplicate-email message rather than overwriting them.

Before rollout, pick one:

1. **Reset** — delete the unclaimed Appwrite users and let them sign up again.
   Simplest, and appropriate for accounts that never completed registration.
2. **Reset passwords** — set a password per user through the Appwrite console.
3. **Add a reset flow** — a `createRecovery`/`updateRecovery` flow so users set
   their own password. The most work, and the right answer if those accounts
   are real people.

Until one of these is done, those patients are locked out rather than
compromised — but they are locked out.

## Upload validation

Identification documents are user-supplied binaries stored in a shared Appwrite
bucket, so both the extension and the contents are attacker-controlled.

`src/lib/uploads.ts` validates server-side, inside `registerPatient`, **before**
the file reaches Appwrite:

| Check | Rule |
| --- | --- |
| Extension | `.pdf`, `.jpg`, `.jpeg`, `.png` |
| Size | 1 byte – 3 MB (`MAX_UPLOAD_BYTES`), sized to stay under the Vercel request-body ceiling — see [Upload size limits](environment.md#upload-size-limits) |
| Content | Magic-byte signature must match the extension |

The signature test is the load-bearing one. A browser-supplied `blob.type` is
whatever the client claims, and a `.jpg` extension proves nothing about the
bytes behind it. `detectMimeType` reads the first 12 bytes and compares them
against the known headers for PDF (`%PDF`), PNG, and JPEG.

Extensions are bound to exactly one content type rather than checked against two
independent allowlists. Without that binding a real PDF named `id.png` satisfies
both lists individually and is then stored and served under an image name —
content-type confusion in the browser and in Appwrite's CDN.

`src/components/FileUploader.tsx` applies the same limits via `useDropzone`
(`accept`, `maxSize`) and reports rejections inline. That is convenience only;
the server check is the one that actually holds, since the browser can be
bypassed by calling the action directly.

> The upload is still stored in a bucket whose visibility is Appwrite-side
> configuration, not application code. Confirm the bucket's permissions in the
> Appwrite console before storing real identity documents.

## Booking integrity

`createAppointment` and `updateAppointment` (when scheduling, not cancelling)
call `assertNoScheduleConflict` in `src/lib/appointment-slots.ts`.

A doctor is considered double-booked when an existing non-cancelled
appointment starts less than `APPOINTMENT_DURATION_MINUTES` (30) before or
after the requested time. Cancelled appointments release their slot. The
conflicting booking is surfaced to the user as a `ScheduleConflictError`.

Appwrite's `Query.between` is inclusive on both bounds, so it is used only as a
±30-minute pre-filter; the exact overlap test runs in JS via `hasSlotOverlap`.

Rejections are race-prone by nature — two concurrent requests can both pass the
check before either is written. Closing that requires an Appwrite unique
compound index on `(primaryPhysician, schedule)`, which would reject the
duplicate at write time instead.

> **Required Appwrite setup:** these queries filter on `primaryPhysician`,
> `schedule`, and `status`. Appwrite rejects range queries against an unindexed
> attribute, so the appointments collection needs `key` indexes on all three or
> booking will fail at runtime with an index error.

### Time zone is still client-asserted

`updateAppointment` validates that `timeZone` names a real IANA zone before it
reaches `formatDateTime`, which throws a `RangeError` on an unknown identifier.
That stops garbage input; it does **not** prove the caller is in that zone. The
value still originates in the browser. It is used only to format the SMS
reminder, so it is cosmetic — it must not gate anything security-relevant.

## What the auth change fixed

The patient portal previously had no authentication at all. `[userId]` was a URL
param with no proof of identity, so any visitor could walk
`/patients/<any-id>/new-appointment` and read or change that patient's data.
These actions were reachable by anyone:

| Action | Before | Now |
| --- | --- | --- |
| `getAppointment(id)` | Read any appointment by guessing or leaking an ID. | Requires the stored owner to be the session subject, or an admin session. |
| `updateAppointment(...)` | Rescheduled or cancelled *any* appointment, with an SMS side effect. | Ownership checked against the stored record; SMS goes to the stored owner. |
| `registerPatient(...)` | Accepted a caller-supplied `userId`. | `userId` comes from the session and cannot be overridden. |
| `getPatient(userId)` | Read any patient's record by id. | No parameter; always the session user's own record. |
| `getUser(userId)` | Read any user's name, email and phone by id. | No parameter; always the session user's own account. |
| `createAppointment(...)` | Open, unvalidated. | Session-derived identity plus server-side slot-conflict checks. |

## Open gaps

### 1. No audit log

Nothing records who viewed or modified a record. Patient identity now exists, so
there is something to log, but nothing records it. Required before this handles
real PHI.

### 2. Passkey is a single shared secret

One value for all admins, so no action can be attributed to a person, and there
is no per-admin revocation. Six digits is a small search space.

`/admin/login` is throttled — 5 attempts per address per 15 minutes, plus an
overall ceiling of 50 per 15 minutes, through `src/lib/auth/throttle.ts`. The
overall ceiling is the load-bearing one, because `x-forwarded-for` is
client-controlled on any deployment not behind a proxy that rewrites it, so a
per-address limit alone can be sidestepped by rotating the header.

Patient sign-in is throttled too — see gap 3.

### 3. Rate limiting is in-process

Booking, registration, account creation, and patient sign-in are throttled
through `src/lib/auth/throttle.ts`, which composes per-subject allowances with a
global ceiling:

| Action | Per subject | Ceiling | Window |
| --- | --- | --- | --- |
| Admin sign-in | 5 per address | 50 | 15 min |
| Patient sign-in | 10 per address **and** per email | 100 | 15 min |
| Account creation | 5 per address | 50 | 1 hour |
| Patient registration | 5 per patient | 100 | 1 hour |
| Appointment booking | 10 per acting identity | 200 | 1 hour |

Session-backed actions are keyed on the signed user id rather than the address,
so a shared or NAT'd address does not throttle unrelated patients. Account
creation has no session yet, so it is keyed on the address.

Sign-in checks two subjects at once: the attempted email slows targeted
guessing, and the address tier plus the global ceiling binds someone rotating
one or the other. Either alone has a hole — a botnet has plenty of addresses,
and a pure email key hands an attacker a lockout lever against the account's
real owner. Both tiers share one global slot per attempt rather than charging it
twice. The email is lowercased so `Alice@example.com` and `alice@example.com`
draw from the same bucket. The 15-minute window keeps that lockout lever short;
a patient password is a much larger search space than the six-digit admin
passkey, so it can be allowed ten guesses and still be impractical to guess.

Registration is throttled **before** the upload, since the upload is the
expensive part and storage is billed per GB. Booking is keyed on the acting
identity, so an admin booking on a patient's behalf is charged to the admin.

The remaining limitation is that the counters are **in process memory**: per
Node instance, reset on restart, and each replica keeps its own on a multi-node
deployment. `RateLimiter` is an interface, so moving to Redis or
`@upstash/ratelimit` is a local change with no call-site edits.

### 4. Session revocation is not immediate

`logoutPatient` revokes the Appwrite session upstream, which is why `sid` is
carried in the cookie. A stolen cookie is still accepted until its 8-hour
expiry, because the proxy and guards check the signature and expiry but do
not call Appwrite to confirm the session is still live. Shortening the TTL or
adding a per-request upstream check are the available options.

## Reporting

Do not open a public issue for a suspected vulnerability. Report it privately
to the maintainers.