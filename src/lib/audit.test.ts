import { afterEach, describe, expect, it, vi } from "vitest";

import { recordAudit } from "./audit";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("recordAudit", () => {
  it("resolves without throwing when Appwrite is not configured", async () => {
    const consoleSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    // No Appwrite env is set in the unit-test process, so constructing the
    // client throws the requireEnv error. The audit path swallows it: a failed
    // audit must never break the operation it is recording.
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
});