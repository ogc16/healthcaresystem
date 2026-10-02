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

## Admin authentication

| Variable | Required | Purpose |
| --- | --- | --- |
| `ADMIN_PASSKEY` | yes | Shared admin passkey, verified server-side in `authenticateAdmin` |
| `SESSION_SECRET` | yes | HMAC key for the session cookie. Use 32+ random characters. |

`ADMIN_PASSKEY` **must not** use the `NEXT_PUBLIC_` prefix. A previous version
of this app named it `NEXT_PUBLIC_ADMIN_PASSKEY`, which published it to every
visitor. Remove that variable from your deployment when you upgrade.

Generate a secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

## CI

| Variable | Purpose |
| --- | --- |
| `CI` | Truthy disables Sentry's source-map upload logging during builds |

Referenced in `next.config.mjs`.

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

## Sentry

Sentry is configured in `next.config.mjs`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `SENTRY_ORG` | `carepulse` | Sentry organization slug |
| `SENTRY_PROJECT` | `care-pulse` | Sentry project slug |
| `SENTRY_AUTH_TOKEN` | — | Required to upload source maps |

Source maps only upload when `SENTRY_AUTH_TOKEN` is present, so builds succeed
without it — errors simply lack stack traces.

> This previously hardcoded `org: "javascript-mastery"`, a leftover from the
> upstream tutorial this project was forked from. Override `SENTRY_ORG` with
> your own slug.
