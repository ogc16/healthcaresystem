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
   edge, before any Appwrite query runs. Matcher is
   `["/admin", "/admin/((?!login).*)"]`, which covers `/admin` and every
   sub-route except `/admin/login`.
2. **Page guard** (`src/app/admin/page.tsx`) re-checks the session and
   redirects. Middleware alone would be a single point of failure.

`getRecentAppointmentList` additionally throws if called without a valid
session, so the data layer fails closed even if a route is added later and
forgets its guard.

## Authentication

There is no patient authentication. Patients are addressed by the `[userId]`
route param only. The only authenticated surface is the admin dashboard —
see [security.md](security.md).

## Data access

All Appwrite calls live in `src/lib/actions/*` and use a server-side API key
(`API_KEY`). That key has full database access and must never reach the
browser — it is read from a non-public env var in
`src/lib/appwrite.config.ts`.

Because the API key is unrestricted, **authorization is the application's
responsibility**, not Appwrite's. Any action that skips a guard exposes the
whole collection. See the open gaps in [security.md](security.md).

## Scheduled/generated routes

- `/` — patient registration form (static)
- `/patients/[userId]/register` — patient onboarding
- `/patients/[userId]/new-appointment` — booking and rescheduling
- `/admin` — dashboard, guarded
- `/admin/login` — passkey entry, public
- `/api/sentry-example-api` — Sentry demo route handler