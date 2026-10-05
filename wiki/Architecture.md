# Architecture

## Shape

A single Next.js application. The App Router renders pages on the server; server
actions are the only write path; Appwrite is the database, auth provider, file
store, and SMS relay.

```
Browser
  │  cookies only — no tokens in JS, no passkey in JS
  ▼
src/proxy.ts                 route protection, runs before every request
  ▼
src/app/**/page.tsx          Server Components, read data
  ▼
src/lib/actions/*.ts         "use server" — the only write path
  ▼
src/lib/auth/guards.ts       identity + ownership checks
  ▼
src/lib/appwrite.config.ts   lazy Appwrite clients
  ▼
Appwrite                     database, auth, storage, messaging
```

The direction only ever goes down. Nothing under `lib/` imports from `app/`, so
the domain logic is testable without rendering anything.

## Directory layout

```
src/
  app/          Routes (App Router), layouts, route handlers
  components/   React components (ui/ = shadcn primitives)
  lib/
    actions/    Server actions — the write path
    auth/       Sessions, guards, rate limiting
    appwrite.config.ts
    uploads.ts  Upload validation
    appointment-slots.ts  Double-booking detection
  constants/    Shared constants
  types/        Global type declarations
  proxy.ts      Route protection
public/         Static assets
docs/           Reference documentation
```

The `@/*` path alias maps to `./src/*`.

## Request flow: an authenticated patient action

```
1. proxy.ts            verifies the hcs_patient_session signature and expiry
2. Server Action       receives FormData over HTTP — treat the payload as hostile
3. Zod schema          parses and validates input, server-side
4. guard               derives identity from the session, not from the payload
5. ownership check     assertCanActForPatient: session user, or an admin
6. Appwrite call       with the server API key
7. revalidatePath()    refreshes the affected route
```

Two rules follow from this and are worth internalising:

- **Identity comes from the session, never from the payload.** No action accepts a
  `userId`. There is nothing for a caller to tamper with.
- **Payload validation is not an authorisation check.** Zod proves the input is
  well-formed, not that the caller may act on it. Both are needed.

## Request flow: admin sign-in

`authenticateAdmin` in `src/app/admin/actions.ts` is the only admin gate:

```
1. Read ADMIN_PASSKEY from the server environment
2. Throttle — per-address, then an overall ceiling
3. Constant-time compare against the submitted passkey
4. On success: HMAC-signed token in an httpOnly cookie
5. redirect("/admin")
```

The throttles run *before* the comparison so a locked-out caller cannot use
response timing to probe the passkey. Details in
[Security Model](Security-Model.md).

## Data access

All Appwrite clients are constructed **lazily**, on first use, and fail by name:

```ts
// src/lib/appwrite.config.ts
client.setProject(requireEnv("PROJECT_ID", PROJECT_ID))
```

Two consequences worth knowing:

- `next build` succeeds with no Appwrite credentials, because nothing
  constructs a client unless a request needs one. CI depends on this.
- A missing variable surfaces as `Missing required environment variable
  PROJECT_ID`, naming the variable, instead of an opaque SDK error deep in a
  build log.

There are two clients, and the distinction is deliberate:

| Client | API key | Used for |
| --- | --- | --- |
| Admin | yes | Everything. Full database access |
| Account | **no** | `createEmailPasswordSession` only |

`account.createEmailPasswordSession` is Appwrite's public sign-in endpoint.
Attaching the admin key would make every login check an admin lookup. Keeping the
account client keyless means Appwrite — not this app — decides whether the
supplied credentials are correct.

> Do not "simplify" this by using `users.createSession(userId)`. That mints a
> valid session for any user straight from the API key, with no password check.
> It is an impersonation helper, not a sign-in path.

## Server actions are endpoints

Every `"use server"` export is a network endpoint reachable by anyone. Two
helpers that only existed to serve one caller were made module-private for this
reason (`sendSMSNotification`, `createUser`). When adding a helper, ask whether it
needs to be an endpoint at all — if not, keep it unexported.

## Sessions

`src/lib/auth/session.ts` is deliberately free of `node:crypto` and
`next/headers`, so the same code runs in the proxy and in Server Components.

Tokens are `role.payload.hmac`, signed with HMAC-SHA256 over `SESSION_SECRET`.
The signature covers the **role as well as the payload**, so a patient token
cannot be replayed as an admin token even though both use the same secret.

Verification checks the signature *before* parsing the payload, and returns
`null` on any failure — a caller that gets a non-null result may trust both the
role and the claims.

## Reporting a data problem instead of guessing

Actions return explicit status rather than empty collections. A page whose job
is to say "no patients have booked" must not render zeroes when the real answer
is "the database was unreachable" — that is a false claim, not an absence of one.

```ts
type RecentAppointments =
  | { status: "ok"; data: AppointmentSummary }
  | { status: "unconfigured"; missing: string[] }
  | { status: "unreachable" };
```

`missingAppwriteEnv()` reports *which* variables are unset, and treats an empty
string as missing — a `.env.local` copied from `.env.example` without editing the
placeholders produces exactly that.

## Tests

Unit tests live next to the code they cover (`*.test.ts`) and cover the security
invariants: session signing and role separation, open-redirect rejection, upload
signature validation, double-booking detection, rate-limit windows, and
configuration reporting.

They deliberately avoid the network and the Appwrite SDK, so the suite runs in
about a second. See [Testing and CI](Testing-and-CI.md).