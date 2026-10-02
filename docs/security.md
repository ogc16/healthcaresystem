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

## Open gaps

None of these are fixed yet. All require patient-level authentication first.

### 1. Server actions are unauthenticated (high)

`src/lib/actions/appointment.actions.ts` exposes these as `"use server"`, so
they are publicly callable endpoints:

| Action | Problem |
| --- | --- |
| `getAppointment(id)` | No ownership check — any caller can read any appointment by guessing or leaking an ID. |
| `updateAppointment(...)` | No ownership check — a caller can reschedule or cancel *any* appointment, and triggers an SMS as a side effect. |
| `createAppointment(...)` | Open by design (patient booking), but unvalidated. |

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

### 4. No upload validation

`src/components/FileUploader.tsx` calls `useDropzone({ onDrop })` with no
`accept`, no `maxSize`, and no server-side MIME sniffing. The UI hint says
"SVG, PNG, JPG or GIF" but nothing enforces it.

### 5. Passkey is a single shared secret

One value for all admins, no per-admin identity, no rate limiting or lockout on
`/admin/login`. Six digits is ~10^6 combinations and is brute-forceable unless
rate-limited at the edge.

## Reporting

Do not open a public issue for a suspected vulnerability. Report it privately
to the maintainers.