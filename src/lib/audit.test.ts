import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildLedgerEntry,
  GENESIS_PREV_HASH,
  ledgerEntryFingerprint,
  recordAudit,
  verifyAuditChain,
} from "./audit";

afterEach(() => {
  vi.restoreAllMocks();
});

const params = {
  action: "patient.read",
  resourceType: "patient",
  resourceId: "patient-1",
  actorRole: "patient",
  actorId: "user-1",
  detail: "opened record",
  ip: "203.0.113.7",
} as const;

describe("ledgerEntryFingerprint", () => {
  const entry = buildLedgerEntry(params, null);

  it("is deterministic for identical entries", () => {
    expect(ledgerEntryFingerprint(entry)).toBe(ledgerEntryFingerprint(entry));
  });

  it("is a 64-char hex sha256", () => {
    expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when any chain-bound field changes", () => {
    const other = { ...entry, action: "patient.create" as const };
    expect(ledgerEntryFingerprint(other)).not.toBe(entry.hash);
  });

  it("is unaffected by the stored hash itself", () => {
    // Verifying an entry must use the same fingerprint regardless of the hash
    // stored next to it, otherwise a re-hash could legitimise itself.
    const rehashed = { ...entry, hash: "0".repeat(64) };
    expect(ledgerEntryFingerprint(rehashed)).toBe(entry.hash);
  });
});

describe("buildLedgerEntry", () => {
  it("seeds a fresh ledger with seq 1 and the genesis anchor", () => {
    const first = buildLedgerEntry(params, null);

    expect(first.seq).toBe(1);
    expect(first.prevHash).toBe(GENESIS_PREV_HASH);
    expect(first.hash).toBe(ledgerEntryFingerprint(first));
  });

  it("links the next entry to its predecessor", () => {
    const first = buildLedgerEntry(params, null);
    const second = buildLedgerEntry(params, { seq: first.seq, hash: first.hash });

    expect(second.seq).toBe(2);
    expect(second.prevHash).toBe(first.hash);
    expect(second.hash).toBe(ledgerEntryFingerprint(second));
  });

  it("records an ISO timestamp", () => {
    const entry = buildLedgerEntry(params, null);

    expect(new Date(entry.occurredAt).toISOString()).toBe(entry.occurredAt);
  });
});

describe("verifyAuditChain", () => {
  const chain = () => {
    const first = buildLedgerEntry(params, null);
    const second = buildLedgerEntry(params, { seq: first.seq, hash: first.hash });
    const third = buildLedgerEntry(params, {
      seq: second.seq,
      hash: second.hash,
    });

    return [first, second, third];
  };

  it("accepts an intact chain", () => {
    expect(verifyAuditChain(chain())).toEqual({ status: "ok", entries: 3 });
  });

  it("accepts entries supplied out of order", () => {
    const [first, second, third] = chain();

    expect(verifyAuditChain([third, first, second])).toEqual({
      status: "ok",
      entries: 3,
    });
  });

  it("accepts an empty ledger", () => {
    expect(verifyAuditChain([])).toEqual({ status: "ok", entries: 0 });
  });

  it("flags a tampered entry", () => {
    const entries = chain();
    entries[1] = { ...entries[1], actorId: "attacker" };

    expect(verifyAuditChain(entries)).toEqual({
      status: "broken",
      reason: "entry 2 content does not match its hash",
    });
  });

  it("flags a deleted entry", () => {
    const entries = chain();

    // Removing the middle entry leaves a seq gap: entry 3 is expected at 2.
    expect(verifyAuditChain([entries[0], entries[2]])).toEqual({
      status: "broken",
      reason: "expected seq 2 but found 3",
    });
  });

  it("flags a reordered seq", () => {
    const entries = chain();
    entries[2] = { ...entries[2], seq: 4 };

    expect(verifyAuditChain(entries)).toEqual({
      status: "broken",
      reason: "expected seq 3 but found 4",
    });
  });

  it("flags a duplicated seq", () => {
    const entries = chain();
    entries[2] = { ...entries[2], seq: 2 };

    expect(verifyAuditChain(entries)).toEqual({
      status: "broken",
      reason: "expected seq 3 but found 2",
    });
  });

  it("flags a detached head against the genesis anchor", () => {
    const entries = chain();
    entries[0] = { ...entries[0], prevHash: "tampered" };

    expect(verifyAuditChain(entries)).toEqual({
      status: "broken",
      reason: "entry 1 does not link to its predecessor",
    });
  });

  it("verifies a truncated ledger against an internal checkpoint", () => {
    const [first, second, third] = chain();

    // A reviewer trusts a checkpoint of entry 1 and replays everything after.
    expect(
      verifyAuditChain([second, third], { seq: first.seq, hash: first.hash })
    ).toEqual({ status: "ok", entries: 2 });
  });

  it("rejects a forged checkpoint", () => {
    const [first, second, third] = chain();

    // The checkpoint claims entry 1 has a hash it never had.
    expect(
      verifyAuditChain([second, third], {
        seq: first.seq,
        hash: "0".repeat(64),
      })
    ).toEqual({
      status: "broken",
      reason: "entry 2 does not link to its predecessor",
    });
  });

  it("rejects an anchor that does not precede the ledger", () => {
    const [first, second, third] = chain();

    // A checkpoint claiming the previous entry was seq 5 cannot be followed by
    // a ledger that still starts at seq 2.
    expect(
      verifyAuditChain([first, second, third], { seq: 5, hash: first.hash })
    ).toEqual({
      status: "broken",
      reason: "expected seq 6 but found 1",
    });
  });
});

describe("recordAudit", () => {
  it("resolves without throwing when Appwrite is not configured", async () => {
    const consoleSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    // No Appwrite env is set in the unit-test process, so constructing the
    // client throws the requireEnv error. The audit path swallows it: a failed
    // audit must never break the operation it is recording. IP capture also
    // degrades to "unknown" outside a request scope instead of throwing.
    await expect(
      recordAudit({
        action: "patient.read",
        resourceType: "patient",
        resourceId: "patient-1",
        actorRole: "patient",
        actorId: "user-1",
      })
    ).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Audit write failed for patient.read"),
      expect.any(Error)
    );
  });

  it("accepts an explicit ip without touching request headers", async () => {
    const consoleSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await recordAudit({ ...params, ip: "198.51.100.2" });

    // Still fails on the unconfigured client, but must not fail on the ip.
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Audit write failed for patient.read"),
      expect.any(Error)
    );
  });
});