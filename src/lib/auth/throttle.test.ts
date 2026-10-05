import { beforeEach, describe, expect, it, vi } from "vitest";

import { createRateLimiter } from "./rate-limit";

const headerStore = new Map<string, string>();

vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (name: string) => headerStore.get(name) ?? null,
  }),
}));

const { clientAddress, createThrottle } = await import("./throttle");

beforeEach(() => headerStore.clear());

describe("createThrottle", () => {
  it("permits a subject up to its allowance, then refuses", async () => {
    const throttle = createThrottle({
      limit: 2,
      overallLimit: 10,
      windowMs: 60_000,
    });

    expect(await throttle.check("alice")).toBeNull();
    expect(await throttle.check("alice")).toBeNull();
    expect(await throttle.check("alice")).toMatch(/Too many requests/);
  });

  it("keeps separate subjects independent", async () => {
    const throttle = createThrottle({
      limit: 1,
      overallLimit: 10,
      windowMs: 60_000,
    });

    expect(await throttle.check("alice")).toBeNull();
    // Alice is locked out; Bob must not be, or one abusive caller could deny
    // service to every other user.
    expect(await throttle.check("bob")).toBeNull();
  });

  it("caps total volume once the subject allowance is generous", async () => {
    const throttle = createThrottle({
      limit: 1,
      overallLimit: 2,
      windowMs: 60_000,
    });

    expect(await throttle.check("alice")).toBeNull();
    expect(await throttle.check("bob")).toBeNull();
    // Rotating the subject gets no further allowance, which is the point of
    // the ceiling for inputs an attacker controls.
    expect(await throttle.check("carol")).toMatch(/Too many requests/);
  });

  it("does not spend the global budget on an already-throttled subject", async () => {
    const throttle = createThrottle({
      limit: 1,
      // Exactly enough for alice + bob + carol. If Alice's retries below
      // consumed any of it, Carol would be refused here.
      overallLimit: 3,
      windowMs: 60_000,
    });

    expect(await throttle.check("alice")).toBeNull();

    // Alice is now over her allowance. These must be refused by the subject
    // tier without touching the global tier, or Alice's retries would exhaust
    // the ceiling and lock out Bob and Carol.
    for (let i = 0; i < 5; i++) {
      expect(await throttle.check("alice")).toMatch(/Too many requests/);
    }

    expect(await throttle.check("bob")).toBeNull();
    expect(await throttle.check("carol")).toBeNull();
  });

  it("releases a subject on reset so a legitimate retry is not penalised", async () => {
    const throttle = createThrottle({
      limit: 1,
      overallLimit: 10,
      windowMs: 60_000,
    });

    expect(await throttle.check("alice")).toBeNull();
    expect(await throttle.check("alice")).toMatch(/Too many requests/);

    throttle.reset("alice");

    expect(await throttle.check("alice")).toBeNull();
  });

  it("rounds the wait up to whole minutes, never zero", async () => {
    const throttle = createThrottle({
      limit: 1,
      overallLimit: 10,
      windowMs: 5_000,
    });

    expect(await throttle.check("alice")).toBeNull();
    // 5s left would floor to "0 minutes", which reads as "try again now".
    expect(await throttle.check("alice")).toMatch(/1 minute/);
  });

  it("frees the allowance once the window passes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);

    try {
      const throttle = createThrottle({
        limit: 1,
        overallLimit: 10,
        windowMs: 60_000,
      });

      expect(await throttle.check("alice")).toBeNull();
      expect(await throttle.check("alice")).toMatch(/Too many requests/);

      vi.setSystemTime(1_700_000_000_000 + 60_001);

      expect(await throttle.check("alice")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("clientAddress", () => {
  it("uses the leftmost forwarded entry, which is the originating client", async () => {
    headerStore.set("x-forwarded-for", "203.0.113.7, 70.41.3.18, 150.172.238.178");

    expect(await clientAddress()).toBe("203.0.113.7");
  });

  it("tolerates whitespace around a forwarded entry", async () => {
    headerStore.set("x-forwarded-for", "  203.0.113.7 ,70.41.3.18");

    expect(await clientAddress()).toBe("203.0.113.7");
  });

  it("falls back to x-real-ip", async () => {
    headerStore.set("x-real-ip", "198.51.100.42");

    expect(await clientAddress()).toBe("198.51.100.42");
  });

  it("buckets header-less callers together rather than unlimited", async () => {
    // An unknown address must not grant a fresh allowance per request, which is
    // what omitting the fallback key would do.
    expect(await clientAddress()).toBe("unknown");
    expect(await clientAddress()).toBe("unknown");
  });

  it("keeps the limiter keys it derives distinct per address", async () => {
    const throttle = createThrottle({
      limit: 1,
      overallLimit: 10,
      windowMs: 60_000,
    });

    headerStore.set("x-forwarded-for", "203.0.113.7");
    expect(await throttle.check(await clientAddress())).toBeNull();

    headerStore.set("x-forwarded-for", "198.51.100.42");
    expect(await throttle.check(await clientAddress())).toBeNull();

    headerStore.set("x-forwarded-for", "203.0.113.7");
    expect(await throttle.check(await clientAddress())).toMatch(
      /Too many requests/
    );
  });
});

describe("the limiter this composes", () => {
  it("is the same primitive the admin sign-in path uses", async () => {
    // Guards against the throttle silently growing its own separate store,
    // which would let two endpoints each grant a full allowance.
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });

    expect(limiter.consume("x").allowed).toBe(true);
    expect(limiter.consume("x").allowed).toBe(false);
  });
});