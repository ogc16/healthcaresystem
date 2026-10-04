import { describe, expect, it } from "vitest";

import { createRateLimiter } from "./rate-limit";

const MINUTE = 60 * 1000;

/** Deterministic clock: tests advance time explicitly instead of sleeping. */
const clock = (start = 1_700_000_000_000) => {
  let current = start;

  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
};

describe("createRateLimiter", () => {
  describe("the attempt allowance", () => {
    it("permits exactly `limit` attempts, then refuses", () => {
      const time = clock();
      const limiter = createRateLimiter({
        limit: 3,
        windowMs: 10 * MINUTE,
        now: time.now,
      });

      expect(limiter.consume("a").allowed).toBe(true);
      expect(limiter.consume("a").allowed).toBe(true);
      expect(limiter.consume("a").allowed).toBe(true);
      expect(limiter.consume("a").allowed).toBe(false);
      expect(limiter.consume("a").allowed).toBe(false);
    });

    it("counts remaining attempts down to zero", () => {
      const limiter = createRateLimiter({
        limit: 3,
        windowMs: 10 * MINUTE,
        now: clock().now,
      });

      expect(limiter.consume("a").remaining).toBe(2);
      expect(limiter.consume("a").remaining).toBe(1);
      expect(limiter.consume("a").remaining).toBe(0);
      expect(limiter.consume("a").remaining).toBe(0);
    });

    it("refuses every attempt when the limit is zero", () => {
      const limiter = createRateLimiter({
        limit: 0,
        windowMs: 10 * MINUTE,
        now: clock().now,
      });

      expect(limiter.consume("a").allowed).toBe(false);
      expect(limiter.consume("a").allowed).toBe(false);
    });

    it("does not let a refused attempt extend the lockout", () => {
      const time = clock();
      const limiter = createRateLimiter({
        limit: 2,
        windowMs: 10 * MINUTE,
        now: time.now,
      });

      limiter.consume("a");
      limiter.consume("a");

      const lockedOut = limiter.consume("a");
      expect(lockedOut.allowed).toBe(false);

      // Hammering through the whole lockout must not push the window forward,
      // otherwise this becomes a permanent ban rather than a delay.
      time.advance(9 * MINUTE);
      expect(limiter.consume("a").allowed).toBe(false);

      time.advance(1 * MINUTE);
      expect(limiter.consume("a").allowed).toBe(true);
    });
  });

  describe("window expiry", () => {
    it("starts a fresh allowance once the window has passed", () => {
      const time = clock();
      const limiter = createRateLimiter({
        limit: 2,
        windowMs: 10 * MINUTE,
        now: time.now,
      });

      limiter.consume("a");
      limiter.consume("a");
      expect(limiter.consume("a").allowed).toBe(false);

      time.advance(10 * MINUTE);

      expect(limiter.consume("a").allowed).toBe(true);
      expect(limiter.consume("a").allowed).toBe(true);
      expect(limiter.consume("a").allowed).toBe(false);
    });

    it("treats the window boundary as expired", () => {
      const time = clock();
      const limiter = createRateLimiter({
        limit: 1,
        windowMs: MINUTE,
        now: time.now,
      });

      expect(limiter.consume("a").allowed).toBe(true);
      expect(limiter.consume("a").allowed).toBe(false);

      time.advance(MINUTE - 1);
      expect(limiter.consume("a").allowed).toBe(false);

      time.advance(1);
      expect(limiter.consume("a").allowed).toBe(true);
    });

    it("reports the remaining lockout in whole seconds, never zero", () => {
      const time = clock();
      const limiter = createRateLimiter({
        limit: 1,
        windowMs: 90 * 1000,
        now: time.now,
      });

      limiter.consume("a");

      time.advance(30_000);
      expect(limiter.consume("a").retryAfterSeconds).toBe(60);

      // A fractional remainder must round up: reporting 0 would invite an
      // immediate retry that is certain to fail.
      time.advance(59_500);
      expect(limiter.consume("a").retryAfterSeconds).toBe(1);
    });

    it("reports no retry delay while attempts are still allowed", () => {
      const limiter = createRateLimiter({
        limit: 2,
        windowMs: MINUTE,
        now: clock().now,
      });

      expect(limiter.consume("a").retryAfterSeconds).toBe(0);
      expect(limiter.consume("a").retryAfterSeconds).toBe(0);
    });
  });

  describe("key isolation", () => {
    it("keeps separate keys independent", () => {
      const limiter = createRateLimiter({
        limit: 2,
        windowMs: 10 * MINUTE,
        now: clock().now,
      });

      limiter.consume("attacker");
      limiter.consume("attacker");
      expect(limiter.consume("attacker").allowed).toBe(false);

      expect(limiter.consume("legitimate").allowed).toBe(true);
      expect(limiter.consume("legitimate").allowed).toBe(true);
    });

    it("does not let one exhausted key deny a fresh key", () => {
      const limiter = createRateLimiter({
        limit: 1,
        windowMs: 10 * MINUTE,
        now: clock().now,
      });

      expect(limiter.consume("a").allowed).toBe(true);
      expect(limiter.consume("b").allowed).toBe(true);
      expect(limiter.consume("a").allowed).toBe(false);
    });
  });

  describe("reset", () => {
    it("restores the full allowance after a success", () => {
      const time = clock();
      const limiter = createRateLimiter({
        limit: 2,
        windowMs: 10 * MINUTE,
        now: time.now,
      });

      limiter.consume("a");
      limiter.consume("a");
      expect(limiter.consume("a").allowed).toBe(false);

      limiter.reset("a");

      expect(limiter.consume("a").allowed).toBe(true);
      expect(limiter.consume("a").allowed).toBe(true);
      expect(limiter.consume("a").allowed).toBe(false);
    });

    it("clears only the named key", () => {
      const limiter = createRateLimiter({
        limit: 1,
        windowMs: 10 * MINUTE,
        now: clock().now,
      });

      limiter.consume("a");
      limiter.consume("b");

      limiter.reset("a");

      expect(limiter.consume("a").allowed).toBe(true);
      expect(limiter.consume("b").allowed).toBe(false);
    });

    it("is a no-op for a key that was never limited", () => {
      const limiter = createRateLimiter({
        limit: 1,
        windowMs: MINUTE,
        now: clock().now,
      });

      limiter.reset("never-seen");

      expect(limiter.consume("never-seen").allowed).toBe(true);
    });
  });

  describe("bounded memory", () => {
    it("sweeps expired keys instead of growing without limit", () => {
      const time = clock();
      const limiter = createRateLimiter({
        limit: 5,
        windowMs: MINUTE,
        now: time.now,
        maxKeys: 4,
      });

      // Five distinct keys against a ceiling of four forces a sweep on the way in.
      for (let index = 0; index < 5; index++) {
        expect(limiter.consume(`key-${index}`).allowed).toBe(true);
      }

      time.advance(MINUTE);

      // Every window has expired, so the next caller gets a fresh allowance
      // rather than inheriting a stale exhausted record.
      const first = limiter.consume("key-0");
      expect(first.allowed).toBe(true);
      expect(first.remaining).toBe(4);
      expect(limiter.consume("key-0").remaining).toBe(3);
    });

    it("keeps enforcing live windows when the ceiling is reached", () => {
      const limiter = createRateLimiter({
        limit: 1,
        windowMs: 10 * MINUTE,
        now: clock().now,
        maxKeys: 2,
      });

      limiter.consume("a");
      limiter.consume("b");
      limiter.consume("c");
      limiter.consume("d");

      // "a" has not expired, so sweeping must not have discarded it.
      expect(limiter.consume("a").allowed).toBe(false);
    });
  });
});