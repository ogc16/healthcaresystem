import { headers } from "next/headers";

import { createRateLimiter } from "./rate-limit";

/**
 * Two-tier throttling for unauthenticated and rate-sensitive server actions.
 *
 * Tier one is per subject, which is what the user experiences. Tier two is a
 * global ceiling on a key the caller cannot vary, which is what actually bounds
 * abuse when the subject is something the caller can influence.
 *
 * Subjects are consumed in order and the global tier is only reached if the
 * subject tier passed. The reverse order would let a caller who is already
 * throttled keep burning the global budget, and a single abuser could then lock
 * every other user out.
 */
export const createThrottle = ({
  limit,
  overallLimit,
  windowMs,
}: {
  limit: number;
  overallLimit: number;
  windowMs: number;
}) => {
  const perSubject = createRateLimiter({ limit, windowMs });
  const overall = createRateLimiter({ limit: overallLimit, windowMs });

  return {
    /** Resolves to `null` when permitted, or a user-facing message when not. */
    check: async (subject: string) => {
      const forSubject = perSubject.consume(subject);

      if (!forSubject.allowed) return refusal(forSubject.retryAfterSeconds);

      const forEveryone = overall.consume("all");

      if (!forEveryone.allowed) return refusal(forEveryone.retryAfterSeconds);

      return null;
    },

    /** Call after a successful action so a legitimate retry is not penalised. */
    reset: (subject: string) => perSubject.reset(subject),
  };
};

const refusal = (retryAfterSeconds: number) =>
  `Too many requests. Try again in ${Math.max(
    1,
    Math.ceil(retryAfterSeconds / 60)
  )} minute(s).`;

/**
 * Best-effort client address, for subjects where no session exists yet.
 *
 * The leftmost `x-forwarded-for` entry is the originating client when the
 * platform appends to the header. The constant fallback keeps header-less callers
 * in one shared bucket rather than handing each a fresh allowance.
 */
export const clientAddress = async () => {
  const store = await headers();

  return (
    store.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    store.get("x-real-ip") ||
    "unknown"
  );
};