# Testing and CI

## What runs on every push

`.github/workflows/ci.yml` runs on pushes and pull requests to `main`:

```
npm ci → typecheck → lint → test → build
```

Node 22, `ubuntu-latest`, 15-minute timeout. Concurrent runs to the same ref are
cancelled, so a rapid series of pushes does not queue four full builds. The
workflow requests `contents: read` and nothing else — CI never needs write access.

Current status: **green**. 96 tests across 7 files.

## Running the gates locally

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # vitest run
npm run build       # production build
```

All four pass without any Appwrite credentials. Client construction is deferred
to first use, so a build that never calls the API needs no secrets. CI relies on
this and so should you.

### A trap on Windows

`eslint .` does **not** lint the same files on Windows as on Linux. It reports
roughly 10 files and silently skips all 41 nested `.tsx` files under `src/app`
and `src/components`.

This is not a theoretical difference. The first CI run failed with 12 lint errors
that local `npm run lint` had reported as clean — including JSX style violations
and an unused variable. Linux CI caught them; Windows did not.

**Treat Linux CI as authoritative.** If you need a local approximation, pass
explicit paths:

```bash
npx eslint src/app src/components src/lib src/types src/proxy.ts
```

## Test suite

Six files, co-located next to the code they cover:

| File | Covers |
| --- | --- |
| `src/lib/auth/session.test.ts` | Token signing, expiry, role separation, signature rejection |
| `src/lib/auth/return-path.test.ts` | Open-redirect rejection |
| `src/lib/uploads.test.ts` | Magic-byte validation, extension/content binding, size limits |
| `src/lib/appointment-slots.test.ts` | Double-booking detection and boundary conditions |
| `src/lib/auth/rate-limit.test.ts` | Window expiry, lockout not extending, key isolation, bounded memory |
| `src/lib/appwrite.config.test.ts` | Missing-variable reporting, including empty strings |

### Conventions

**No network, no Appwrite SDK, no wall-clock sleeps.** The suite runs in about a
second, which is the main reason it actually gets run.

For time-dependent code, inject the clock rather than sleeping:

```ts
const clock = (start = 1_700_000_000_000) => {
  let current = start;
  return { now: () => current, advance: (ms: number) => { current += ms; } };
};

const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, now: clock().now });
```

Rate-limit tests build a fresh limiter per test so state cannot leak between
them.

For code that reads `process.env`, snapshot and restore it:

```ts
const snapshot = new Map(NAMES.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const [name, value] of snapshot) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
```

### What to test

Security invariants get tests. When you touch auth, ownership, upload
validation, or slot conflicts, the change is not done until a test would fail
without it.

## No E2E suite yet

There is no Playwright coverage. That is a real gap, not an oversight — see the
[Roadmap](Roadmap.md). Any E2E suite needs a running app with working Appwrite
credentials, since the critical paths (registration, booking, cancellation) all
require a live database.

## Adding a CI check

Edit `.github/workflows/ci.yml`. Two constraints to respect:

- **Keep it credential-free.** If a new step needs a secret, make it skip
  cleanly when the secret is absent — as the Sentry source-map upload does — so
  forks and pull requests from outside contributors still pass.
- **Put steps in cheapest-first order.** Typecheck fails fastest, build slowest.
  Ordering them this way means most failures surface in seconds.