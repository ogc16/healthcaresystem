# Architecture

## Stack

Next.js 14 (App Router) · TypeScript · Tailwind + shadcn/ui · Appwrite
(databases, storage, messaging) · Sentry.

## Request flow

```
Browser
  │
  ├─ src/middleware.ts ──── edge runtime, runs before every /admin* request
  │      └─ validates HMAC-signed session cookie → redirect to /admin/login
  │
  ├─ Server Component (src/app/**/page.tsx)
  │      └─ calls "use server" actions in src/lib/actions/
  │
  └─ Server Action ("use server")
         └─ src/lib/appwrite.config.ts → Appwrite REST API
```

## Middleware vs. guards

Two layers protect `/admin`, deliberately:

1. **Middleware** (`src/middleware.ts`) rejects unauthenticated requests at the
   edge for the routes in
   `["/admin", "/admin/((?!login).*)", "/patients/:path*"]`, which covers
   `/admin` and every sub-route except `/admin/login`, plus the whole patient
   portal. Admin routes require an admin cookie; patient routes require a
   patient cookie, so neither session can be replayed against the other's area.
2. **Page guard** (`src/app/admin/page.tsx`) re-checks the session and
   redirects. Middleware alone would be a single point of failure.

`getRecentAppointmentList` additionally throws if called without a valid
session, so the data layer fails closed even if a route is added later and
forgets its guard.

## Authentication

Two independent surfaces, each gated by its own cookie and both signed with
`SESSION_SECRET`:

- **Admin** — a shared passkey verified server-side, issuing the
  `hcs_admin_session` cookie.
- **Patient** — Appwrite email/password, verified by Appwrite, issuing the
  `hcs_patient_session` cookie carrying the user's `uid` and Appwrite session id.

The token shape is `<role>.<base64url(payload)>.<hmac>` and the role is inside the
signed region, so a patient cookie cannot be replayed as an admin cookie or the
reverse. Patient routes carry **no** identity parameter — the session is the only
source of who the caller is, which is why ownership checks compare against the
session rather than a request body.

See [security.md](security.md) for the full model, the enforcement table, and the
open gaps.

## Data access

All Appwrite calls live in `src/lib/actions/*` and use a server-side API key
(`API_KEY`). That key has full database access and must never reach the
browser — it is read from a non-public env var in
`src/lib/appwrite.config.ts`.

Because the API key is unrestricted, **authorization is the application's
responsibility**, not Appwrite's. Any action that skips a guard exposes the
whole collection. See the open gaps in [security.md](security.md).

## Scheduled/generated routes

- `/` — patient account creation (public)
- `/login` — patient sign-in (public)
- `/patients/register` — patient onboarding, session-derived identity
- `/patients/new-appointment` — booking
- `/patients/new-appointment/success` — confirmation, ownership-checked
- `/admin` — dashboard, guarded
- `/admin/login` — passkey entry, public
- `/api/sentry-example-api` — Sentry demo route handler