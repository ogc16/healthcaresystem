# Environment variables

Copy `.env.example` to `.env.local`. `.env.local` is gitignored — never commit
real values.

## Appwrite (server)

| Variable | Required | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_ENDPOINT` | yes | Appwrite server endpoint, e.g. `https://cloud.appwrite.io/v1` |
| `PROJECT_ID` | yes | Appwrite project ID |
| `API_KEY` | yes | Server API key. **Full database access.** Never expose to the browser. |
| `DATABASE_ID` | yes | Database containing the collections below |
| `PATIENT_COLLECTION_ID` | yes | Patients collection ID |
| `DOCTOR_COLLECTION_ID` | yes | Doctors collection ID |
| `APPOINTMENT_COLLECTION_ID` | yes | Appointments collection ID |

Read in `src/lib/appwrite.config.ts`.

## Appwrite (client)

| Variable | Required | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_BUCKET_ID` | yes | Storage bucket for registration documents |

`NEXT_PUBLIC_` variables are inlined into the client bundle at build time.
Only put genuinely public identifiers behind this prefix — never a secret.

## Authentication secrets

| Variable | Required | Purpose |
| --- | --- | --- |
| `ADMIN_PASSKEY` | yes | Shared admin passkey, verified server-side in `authenticateAdmin` |
| `SESSION_SECRET` | yes | HMAC key for **both** session cookies. Use 32+ random characters. |

`ADMIN_PASSKEY` **must not** use the `NEXT_PUBLIC_` prefix. A previous version
of this app named it `NEXT_PUBLIC_ADMIN_PASSKEY`, which published it to every
visitor. Remove that variable from your deployment when you upgrade.

Patient passwords need no environment variable — they are held by Appwrite and
never reach this app. `SESSION_SECRET` signs the patient cookie too, so rotating
it signs everyone out of both surfaces at once.

Generate a secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

## CI

| Variable | Purpose |
| --- | --- |
| `CI` | Truthy disables Sentry's source-map upload logging during builds |

Referenced in `next.config.mjs`.

## Upload size limits

Identification documents travel to `registerPatient` inside the request body
of a server action, so three limits stack up:

| Limit | Value | Where |
| --- | --- | --- |
| `MAX_UPLOAD_BYTES` | 3 MB | `src/lib/uploads.ts` — validates one file |
| `serverActions.bodySizeLimit` | 4 MB | `next.config.mjs` — Next.js request body cap |
| Vercel request body | 4.5 MB (Node) / 4 MB (Edge) | Platform, not configurable |

The app-level limit is intentionally the lowest. Anything higher is unreachable:
the file passes validation and then dies at the edge with a bare 413, which
gives the user nothing to act on.

Note that Next.js defaults `bodySizeLimit` to **1 MB**. Without the explicit
`4mb` above, any document over 1 MB fails regardless of what the app allows.

## Appwrite collection setup

Beyond the variables above, the appointments collection needs indexes. The
conflict check in `src/lib/appointment-slots.ts` filters on three attributes,
and Appwrite rejects range queries against an unindexed attribute:

| Attribute | Index type | Why |
| --- | --- | --- |
| `primaryPhysician` | `key` | Equality filter for the doctor being booked |
| `schedule` | `key` | `Query.between` window for overlap detection |
| `status` | `key` | `Query.notEqual("status", "cancelled")` |

Without these, booking fails at runtime with an index error rather than at build
time.

## Appwrite authentication setup

Patient sign-in depends on Appwrite accepting email/password credentials. Confirm
in the Appwrite console:

| Setting | Required | Notes |
| --- | --- | --- |
| Email/password auth enabled | yes | `/login` calls `account.createEmailPasswordSession`. If email/password is disabled for the project, every sign-in fails with an auth error. |
| User registration | your call | If enabled, anyone can create an Appwrite account directly via the API, bypassing this app's form. Turn it off if self-registration here is the only path you want. |
| Session length | optional | Appwrite's own session lifetime. This app's cookie is 8 hours; Appwrite's default (1 year) is longer, so the cookie is the binding constraint. |

> **Before rollout:** accounts created before patient auth existed have no
> password and cannot sign in. See "Existing accounts have no password" in
> [security.md](security.md#existing-accounts-have-no-password) for the three
> ways to handle them.

## Sentry

**Error reporting is off unless you configure it.** Two variables control where
events go, one per runtime:

| Variable | Scope | Purpose |
| --- | --- | --- |
| `SENTRY_DSN` | Server, edge | Where server-side events are sent |
| `NEXT_PUBLIC_SENTRY_DSN` | Browser | Where client-side events are sent. Inlined into the client bundle at **build** time |

Set a DSN and the SDK initialises. Leave it empty and nothing is sent anywhere.
`NEXT_PUBLIC_` belongs only on the browser DSN; giving the server DSN that prefix
would leak it into the bundle.

A DSN is a write-only ingest key, not a credential — it is designed to be public,
and it grants nothing beyond submitting events. It still matters that it points
at your own project.

Separately, `next.config.mjs` uses these for source-map uploads only:

| Variable | Default | Purpose |
| --- | --- | --- |
| `SENTRY_ORG` | `carepulse` | Sentry organization slug |
| `SENTRY_PROJECT` | `care-pulse` | Sentry project slug |
| `SENTRY_AUTH_TOKEN` | — | Required to upload source maps |

Source maps only upload when `SENTRY_AUTH_TOKEN` is present, so builds succeed
without it — errors simply lack stack traces.

> Both the DSN and `SENTRY_ORG` previously pointed at projects belonging to the
> upstream tutorial this project was forked from, so any deployment reported its
> errors, session replays, and source maps to a third party by default. The DSN
> is fixed in the current code; the old value is still in git history, so rotate
> the upstream project if that matters to you.
