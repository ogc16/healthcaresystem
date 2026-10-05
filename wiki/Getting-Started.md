# Getting Started

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | 22 or newer | Node 20 is past end-of-life. Sentry needs ≥20.19, Vitest needs ≥22.12 |
| npm | 10 or newer | Ships with Node |
| Appwrite project | — | Self-hosted or [Appwrite Cloud](https://appwrite.io) |

## Setup

```bash
git clone https://github.com/ogc16/healthcaresystem
cd healthcaresystem
npm install
cp .env.example .env.local
```

Then edit `.env.local`. It is gitignored — never commit real values. The full
list of variables is in [docs/environment.md](../docs/environment.md); the
minimum to boot is:

```bash
NEXT_PUBLIC_ENDPOINT=https://cloud.appwrite.io/v1
PROJECT_ID=<your project id>
API_KEY=<your server API key>
DATABASE_ID=<your database id>
PATIENT_COLLECTION_ID=<...>
DOCTOR_COLLECTION_ID=<...>
APPOINTMENT_COLLECTION_ID=<...>
NEXT_PUBLIC_BUCKET_ID=<storage bucket>

ADMIN_PASSKEY=<a long random string>
SESSION_SECRET=<see below>
```

```bash
npm run dev
```

- Patient portal: <http://localhost:3000>
- Admin dashboard: <http://localhost:3000/admin/login>

## Generating `SESSION_SECRET`

This key signs **both** session cookies. Rotating it invalidates every active
admin and patient session at once, so set it once and keep it safe.

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

## Choosing `ADMIN_PASSKEY`

Use a long random string, not a short number:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

The value is compared server-side and never reaches the browser. Attempts are
throttled (see [Security Model](Security-Model.md)), but a six-digit passkey
still leaves a small search space — treat this as a shared secret and rotate it.

## Appwrite console setup

Two things must be configured outside the codebase.

### 1. Indexes on the appointments collection

Booking fails at runtime — not at build time — if these are missing, because
Appwrite rejects range queries against an unindexed attribute.

| Attribute | Index type | Why |
| --- | --- | --- |
| `primaryPhysician` | `key` | Equality filter for the doctor being booked |
| `schedule` | `key` | `Query.between` window for overlap detection |
| `status` | `key` | Excludes cancelled appointments |

### 2. Authentication method

| Setting | Required | Why |
| --- | --- | --- |
| Email/password auth | yes | `/login` calls `account.createEmailPasswordSession`. If it is disabled, every sign-in fails |
| User self-registration | your call | If enabled, anyone can create an account directly via the API, bypassing this app's form |
| Storage bucket permissions | verify | Uploads land in a shared bucket. Confirm the visibility settings before storing identity documents |

## Verify the install

```bash
npm run typecheck
npm test
npm run build
```

All three should pass without any Appwrite credentials set. Client construction
is deferred to first use, so a build that never calls the API needs no secrets —
the same property CI relies on.

To confirm the app can reach Appwrite, sign in as a patient and load
`/admin`. A correctly configured server renders three stat cards. A server
missing credentials renders an **"Appwrite is not configured"** panel naming the
variables to set — that is the intended behaviour, not a crash. See
[Troubleshooting](Troubleshooting.md).

## Before your first deploy

1. Remove `NEXT_PUBLIC_ADMIN_PASSKEY` from your hosting environment if it is
   there. An earlier version of this app shipped the admin passkey to every
   visitor's browser. Use `ADMIN_PASSKEY`.
2. Set `SESSION_SECRET` in the deployment environment. It is **not** optional —
   without it, sign-in fails with `SESSION_SECRET is not set`.
3. Fix the Sentry DSN. The DSN is currently **hardcoded** in
   `sentry.client.config.ts` and there is no environment variable for it. As
   committed, this app's errors and session replays are reported to the upstream
   author's Sentry project. Either create your own project and replace the DSN in
   that file, or move it behind an environment variable — wiring it up is an open
   task in the [Roadmap](Roadmap.md). See
   [Troubleshooting](Troubleshooting.md#sentry-reports-to-the-wrong-project).
4. Read [Security Model](Security-Model.md) end to end, and
   [Roadmap and Open Gaps](Roadmap.md) before handling any real patient data.