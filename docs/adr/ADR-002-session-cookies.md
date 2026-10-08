# ADR-002: Self-signed HMAC session cookies, not JWT

- Status: Accepted
- Date: 2026-10-08

## Context

Both roles (patient, admin) authenticate with the app. Sessions need to be
verifiable in server actions and route handlers, revocable on logout, and cheap
to check on every request. Off-the-shelf options (Appwrite JWTs, `next-auth`,
`jose`) exist, but the actual requirement is small: an opaque, signed, expiring
cookie.

## Decision

Issue a self-signed session token of the shape
`<role>.<base64url(json claims)>.<hmac-sha256>` and set it in an
HttpOnly cookie. Implementation lives entirely in
`src/lib/auth/session.ts`:

- Separate cookies — `hcs_patient_session` / `hcs_admin_session` — so the two
  roles never confuse each other, and the middleware and `getSession`
  (`src/lib/auth/guards.ts`) agree on which cookie means what.
- The role is part of the signed value, so a patient token cannot be replayed
  as an admin token even though both share `SESSION_SECRET`.
- HMAC-SHA-256 over the whole `role.body` string, compared with a constant-time
  equality check.
- 8-hour expiry; patient tokens carry the Appwrite user id (`uid`) and session
  id (`sid`) so logout can revoke the Appwrite session, not just drop the
  cookie.
- Payload is JSON rather than dot-joined fields because Appwrite ids can
  contain characters that a positional split would break.

Password verification and account creation are delegated to Appwrite's users
API (`getUsers().create(...)`); the app never stores or hashes a password
itself. Admin sign-in is a passkey, throttled alongside patient sign-in
(ADR-007 / `src/lib/auth/throttle.ts`).

## Consequences

**Positive.** No JWT library dependency; revocation is real (Session revocation
in Appwrite + cookie drop on logout); the middleware can do a cheap outer shell
signature check on Edge while server actions rely on the authoritative
`getSession`.

**Negative.** Secrets must be deployed and rotated with the app
(`SESSION_SECRET`); there is no cryptographic separation of the two roles'
signing keys (the role claim carries the separation); tokens are not
introspectable by Appwrite without a second call.

## Considered alternatives

**Appwrite JWTs.** Appendix: heavier, adds a second secret source, and still
needs a cookie to carry it.

**`next-auth` (Auth.js).** Full OAuth/credentials provider machinery for a
two-role cookie; more surface area than the actual requirement.