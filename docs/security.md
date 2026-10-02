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

Cookie `hcs_admin_session` holds `admin.<expiresAt>.<hmac>` and is set with:

| Attribute | Value |
| --- | --- |
| `httpOnly` | `true` — unreachable from JS, so XSS cannot read it |
| `secure` | `true` in production |
| `sameSite` | `lax` — plus Next.js server-action origin checks |
| `path` | `/` |
| `maxAge` | 8 hours |

The HMAC is keyed by `SESSION_SECRET`. Rotating that secret invalidates every
active session.

### Why the token is signed

An unsigned cookie would let a visitor edit `expiresAt` and mint an immortal
session. The signature covers the role *and* the expiry, and verification
rejects any token whose signature doesn't match. Session logic lives in
`src/lib/auth/session.ts` and is deliberately free of `node:crypto` and
`next/headers` so it runs in both the Edge middleware and the Node runtime.

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

## Upload validation

Identification documents are user-supplied binaries stored in a shared Appwrite
bucket, so both the extension and the contents are attacker-controlled.

`src/lib/uploads.ts` validates server-side, inside `registerPatient`, **before**
the file reaches Appwrite:

| Check | Rule |
| --- | --- |
| Extension | `.pdf`, `.jpg`, `.jpeg`, `.png` |
| Size | 1 byte – 5 MB (`MAX_UPLOAD_BYTES`) |
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
reminder, so it is cosmetic — it must not gate anything security-relevant until
patient authentication exists (gap 2).

## Open gaps

None of these are fixed yet. All require patient-level authentication first.

### 1. Server actions are unauthenticated (high)

`src/lib/actions/appointment.actions.ts` exposes these as `"use server"`, so
they are publicly callable endpoints:

| Action | Problem |
| --- | --- |
| `getAppointment(id)` | No ownership check — any caller can read any appointment by guessing or leaking an ID. |
| `updateAppointment(...)` | No ownership check — a caller can reschedule or cancel *any* appointment, and triggers an SMS as a side effect. |
| `createAppointment(...)` | Open by design (patient booking), but unvalidated. Slot conflicts are now checked — see [Booking integrity](#booking-integrity). |

Enforcement requires a patient session and a `document.userId === session.userId`
comparison.

### 2. No patient authentication at all

`[userId]` is a URL param with no proof of identity. Any visitor can walk
`/patients/<any-id>/new-appointment` and read or change that patient's data.
This is the root cause of gap 1.

Planned approach: Appwrite sessions (`users.createSession`), roles as an
Appwrite label, ownership enforced in the action layer.

### 3. No audit log

Nothing records who viewed or modified a record. Required before this handles
real PHI.

### 4. Passkey is a single shared secret

One value for all admins, no per-admin identity, no rate limiting or lockout on
`/admin/login`. Six digits is ~10^6 combinations and is brute-forceable unless
rate-limited at the edge.

### 5. No rate limiting on booking or registration

`createAppointment` and `registerPatient` are unauthenticated and unbounded, so
they can be used to exhaust the messaging quota or fill the storage bucket.

## Reporting

Do not open a public issue for a suspected vulnerability. Report it privately
to the maintainers.