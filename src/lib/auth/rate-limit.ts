/**
 * Fixed-window attempt counting, in process memory.
 *
 * Scope, stated plainly: this is per Node process and per deployment. It is not
 * shared across instances, and it resets on restart. That is enough to make
 * online guessing tedious against a single instance, which is what the admin
 * passkey is defending, but it is not a substitute for a shared store if this is
 * ever scaled to more than one instance or run somewhere without a fixed egress
 * address. Swapping in Redis means reimplementing this interface, nothing else.
 *
 * Deliberately not a sliding window or a token bucket: a fixed window is
 * trivially explainable to a user who gets locked out ("too many attempts, wait
 * N minutes") and its worst case is a known 2x burst at the window boundary,
 * which the separate global ceiling in the caller absorbs.
 */

export type RateLimitDecision = {
  allowed: boolean;
  /** Attempts still available in the current window. */
  remaining: number;
  /** Seconds until a retry is permitted. Zero when allowed. */
  retryAfterSeconds: number;
};

export type RateLimiter = {
  /** Counts one attempt against `key` and reports whether it was permitted. */
  consume: (key: string) => RateLimitDecision;
  /** Forgets the record for `key`. Call after a successful authentication. */
  reset: (key: string) => void;
};

export type RateLimiterOptions = {
  /** Attempts permitted per window. */
  limit: number;
  windowMs: number;
  /** Injectable clock so tests do not depend on wall-clock time. */
  now?: () => number;
  /**
   * Ceiling on tracked keys, swept once exceeded. Without it, a scan rotating
   * source addresses would grow this map for the life of the process.
   */
  maxKeys?: number;
};

type Window = {
  count: number;
  resetAt: number;
};

export const createRateLimiter = ({
  limit,
  windowMs,
  now = Date.now,
  maxKeys = 10_000,
}: RateLimiterOptions): RateLimiter => {
  const windows = new Map<string, Window>();

  const sweep = (at: number) => {
    for (const [key, window] of windows) {
      if (window.resetAt <= at) windows.delete(key);
    }
  };

  return {
    consume(key) {
      const at = now();
      const existing = windows.get(key);

      if (!existing || existing.resetAt <= at) {
        if (windows.size >= maxKeys) sweep(at);

        windows.set(key, { count: 1, resetAt: at + windowMs });

        return {
          allowed: limit > 0,
          remaining: Math.max(0, limit - 1),
          retryAfterSeconds: 0,
        };
      }

      // Refused attempts must not push resetAt forward. If they did, hammering
      // during a lockout would hold the lockout open indefinitely and turn the
      // limiter into a permanent ban.
      if (existing.count >= limit) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((existing.resetAt - at) / 1000)
          ),
        };
      }

      existing.count += 1;

      return {
        allowed: true,
        remaining: Math.max(0, limit - existing.count),
        retryAfterSeconds: 0,
      };
    },

    reset(key) {
      windows.delete(key);
    },
  };
};