# Troubleshooting

## `Missing required environment variable PROJECT_ID`

The most common one. The server has no Appwrite credentials.

```
Error: Missing required environment variable PROJECT_ID. See .env.example.
    at requireEnv (src/lib/appwrite.config.ts)
    at getClient (...)
    at getRecentAppointmentList (src/lib/actions/appointment.actions.ts)
    at AdminPage (src/app/admin/page.tsx)
```

**This is now reported in the UI, not just the console.** `/admin` renders an
**"Appwrite is not configured"** panel listing exactly which variables to set.

| Cause | Fix |
| --- | --- |
| `.env.local` not created | `cp .env.example .env.local` |
| Variables present but empty | Fill them in. An **empty string counts as missing** — copying `.env.example` without editing the placeholders produces exactly this |
| `.env.local` edited after the server started | Restart the dev server. Next.js reads env at boot |
| Deployed but not configured | Set them in your hosting provider's environment settings |
| `NEXT_PUBLIC_*` changed | Client vars are inlined at **build time**. Rebuild, don't just restart |

The required set is `NEXT_PUBLIC_ENDPOINT`, `PROJECT_ID`, `API_KEY`,
`DATABASE_ID`, `PATIENT_COLLECTION_ID`, `DOCTOR_COLLECTION_ID`,
`APPOINTMENT_COLLECTION_ID`.

`NEXT_PUBLIC_BUCKET_ID` is deliberately *not* required by the dashboard — it only
gates file uploads, so the dashboard will not ask for it.

### Why you get a panel and not zeroes

An earlier version returned an empty summary on any failure, which made three
different situations look identical: an empty database, a missing configuration,
and an unreachable Appwrite. On a screen whose job is to say whether patients
have booked, "0 appointments" is a claim — and a silently wrong one is worse
than a visible error. So the bad states are now distinct and named.

## `SESSION_SECRET is not set`

Set `SESSION_SECRET` in `.env.local` and in your deployment environment. It signs
both session cookies and is not optional.

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Rotating it invalidates every active admin and patient session at once.

## Admin sign-in says "not configured"

`ADMIN_PASSKEY` is unset. Note it must **not** carry the `NEXT_PUBLIC_` prefix.
If your hosting environment still has `NEXT_PUBLIC_ADMIN_PASSKEY` from the
original template, delete it — that version published the passkey to every
visitor — and set `ADMIN_PASSKEY` instead.

## "Too many attempts. Try again in N minute(s)"

The rate limiter is working. 5 attempts per address per 15 minutes, plus an
overall ceiling of 50. The lockout window does not extend while you retry, so
waiting the stated time is enough.

If you are being locked out as a legitimate admin, the global ceiling may have
been consumed by someone else — that ceiling is shared across all addresses by
design.

## Booking fails with an index error

Appwrite rejects range queries against an unindexed attribute. The appointments
collection needs `key` indexes on:

| Attribute | Used by |
| --- | --- |
| `primaryPhysician` | Equality filter for the doctor being booked |
| `schedule` | `Query.between` overlap window |
| `status` | Excludes cancelled appointments |

This fails at runtime, not at build time. See
[Getting Started](Getting-Started.md#appwrite-console-setup).

## Upload rejected despite a valid-looking file

The extension and the content are bound to each other. A real PDF named `id.png`
is rejected because the signature says PDF and the extension says PNG.

| Message | Meaning |
| --- | --- |
| Unsupported file type | Extension not in `.pdf`, `.jpg`, `.jpeg`, `.png` |
| File does not match its extension | Magic bytes disagree with the extension |
| File too large | Over `MAX_UPLOAD_BYTES` (3 MB) |

Three limits stack up, and the app-level one is intentionally the lowest —
anything higher passes validation and then dies at the platform with a bare 413
that tells the user nothing:

| Limit | Value | Where |
| --- | --- | --- |
| `MAX_UPLOAD_BYTES` | 3 MB | `src/lib/uploads.ts` |
| `serverActions.bodySizeLimit` | 4 MB | `next.config.mjs` |
| Vercel request body | 4.5 MB | Platform |

## Pre-existing accounts cannot sign in

Accounts created before patient auth existed are passwordless — the original form
collected only name, email, and phone — and `createEmailPasswordSession` has no
password to check. Re-registering the same email returns the duplicate-email
message rather than overwriting them.

Three options, in `docs/security.md`: delete and let them re-register, set
passwords via the Appwrite console, or build a recovery flow. The third is the
most work and the right answer if those accounts are real people.

## Sentry reports to the wrong project

Reporting is off unless a DSN is configured, so if you are seeing events in a
project you do not own, something is setting a DSN. Check `SENTRY_DSN` and
`NEXT_PUBLIC_SENTRY_DSN` in your deployment environment first.

If you still see this symptom, the DSN is likely still in your build:

| Symptom | Cause | Fix |
| --- | --- | --- |
| Events in the upstream author's project, running a commit from this repo | Stale `NEXT_PUBLIC_SENTRY_DSN` baked into an old build | Redeploy with it unset. The browser DSN is inlined at **build** time, so clearing it in the runtime environment changes nothing until you rebuild |
| Server-side events go somewhere unexpected | `SENTRY_DSN` is set | Unset it, or point it at your project |
| Events appear with no DSN configured at all | A previous release hardcoded one | Update to a commit after the DSN was parameterised, then rebuild |

The DSN used to be committed in all three `sentry.*.config.ts` files. That is
fixed in the current code, but **git history still contains it**. Anyone who
cloned the repository earlier can send events to that project, and rotating the
DSN upstream is the only way to stop that — deleting it from `HEAD` does not
retract it.

## Lint passes locally but fails in CI

Almost certainly the Windows ESLint traversal bug — `eslint .` skips nested
`.tsx` files on Windows. See
[Testing and CI](Testing-and-CI.md#a-trap-on-windows).

Run with explicit paths to reproduce what CI sees:

```bash
npx eslint src/app src/components src/lib src/types src/proxy.ts
```

## Hydration mismatch on `<html>`

The layout uses a static `style={{ colorScheme: "dark" }}` and no theme provider.
There are deliberately no `.light`/`.dark` rules in `globals.css`, no `dark:` or
`light:` variants, and no `useTheme` calls.

If you reintroduce a theme toggle, reintroduce the hydration handling with it —
a provider that writes `class` and `color-scheme` from `localStorage` will
disagree with the server render unless it is suppressed correctly. `next-themes`
was removed for exactly this reason.