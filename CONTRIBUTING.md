# Contributing to CarePulse

Thanks for taking the time to contribute. This is a healthcare patient
management system, so changes carry more weight than in a typical app: the code
handles protected health information and owns authentication and authorization
for both patients and clinic staff.

## Prerequisites

| Tool | Version |
| --- | --- |
| Node.js | >= 20.9.0 |
| npm | 11.19.0 (`packageManager` in `package.json`) |

## Setup

```bash
git clone https://github.com/ogc16/healthcaresystem.git
cd healthcaresystem
npm install
cp .env.example .env.local
```

Then fill in `.env.local`. Never commit it — it holds the Appwrite API key, the
admin passkey, and the session signing secret. Each variable is documented in
[docs/environment.md](docs/environment.md).

Appwrite also needs configuration outside this repo before the app will work
end to end:

- Email/password authentication enabled for the project.
- Attributes indexed for the fields queried at request time: `primaryPhysician`,
  `schedule`, and `status` on the appointments collection, and `userId` on the
  patients collection. Unindexed queries fail at runtime rather than at build.

## Running locally

```bash
npm run dev     # dev server
npm run build   # production build
npm run start   # serve the production build
```

## Before you open a pull request

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

All four must pass. `typecheck` and `lint` catch most mechanical problems;
`test` guards the security invariants below; `build` is the one that catches
framework-level breakage, so do not skip it.

Tests use [Vitest](https://vitest.dev) and live beside the code they cover as
`*.test.ts`. The current suite concentrates on the parts of this codebase that
fail silently and dangerously if they regress:

| File | Covers |
| --- | --- |
| `src/lib/auth/session.test.ts` | token signing, expiry, role separation, malformed payloads |
| `src/lib/auth/return-path.test.ts` | post-login redirect sanitisation (open redirect) |
| `src/lib/uploads.test.ts` | magic-byte upload validation, extension/content binding, size limit |
| `src/lib/appointment-slots.test.ts` | double-booking detection at the slot boundary |

Run `npm run test:watch` while working on one of them.

If you change any of the behaviour listed under
[Security-sensitive changes](#security-sensitive-changes), add or update a test in
the same pull request. A change to auth, upload validation or scheduling that
lands without a test is the one thing this repository should not accept.

## Security-sensitive changes

Read [docs/security.md](docs/security.md) before changing anything in these
areas. They are easy to break silently:

- **Session tokens** (`src/lib/auth/session.ts`) — cookies are signed with
  HMAC-SHA256 over a `<role>.<payload>.<signature>` token. The `account` Appwrite
  client is intentionally **keyless** so Appwrite, not this app, decides whether
  a password is correct. Do not attach the admin API key to it.
- **Route gating** (`src/proxy.ts`) — matcher and redirect behaviour for
  `/admin` and `/patients`.
- **Server actions** — every file under `src/lib/actions/` using `"use server"`
  is a network endpoint. Validate input with the Zod schemas in
  `src/lib/validation.ts` at the top of the function, and never trust an
  identity or `userId` that arrives from the client. Derive it from the signed
  session instead.
- **Ownership checks** — appointment reads and writes must authorise against
  the *stored* record, not against a `userId` echoed back in the payload.
- **Uploads** (`src/lib/uploads.ts`) — allowlists are bound to magic bytes, and
  `MAX_UPLOAD_BYTES` must stay below `serverActions.bodySizeLimit` in
  `next.config.mjs` and below the platform request body ceiling.

Never log secrets, session cookies, API keys, or patient records. Errors that
need context should describe the failure, not the payload.

## Commit messages

The project uses Conventional Commits. The security history uses scopes that are
worth reusing, because they make the security-relevant commits easy to audit:

```
fix(security): enforce ownership on appointment updates
fix(vendor): size uploads under the Vercel request body ceiling
fix: update formatDateTime to use client timezone before sending sms
```

`security` and `vendor` are the two used most often here.

## Pull requests

1. Branch from `main`.
2. Keep the change focused; unrelated cleanups belong in their own PR.
3. Fill in what you changed, why, and how you verified it. If you verified
   against a live Appwrite project, say so — the automated checks do not cover
   real Appwrite round-trips.
4. Call out anything you could not verify. An honest gap is more useful than an
   implied guarantee.

## Reporting a security vulnerability

Please do not open a public issue for a vulnerability. Report it privately to
the maintainers so a fix can be prepared before disclosure.

## Code of Conduct

Participation in this project is governed by
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

MIT — see [LICENSE](LICENSE).