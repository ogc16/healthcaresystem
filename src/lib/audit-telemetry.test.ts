import { afterEach, describe, expect, it, vi } from "vitest";

import { appendAuditEntry } from "./audit";
import { clearTelemetryListeners, subscribeTelemetry } from "./telemetry";

/**
 * The telemetry hookup for the audit ledger is the one place the two modules
 * meet, so it gets its own focused suite: `appendAuditEntry` broadcasts the
 * committed entry, and only a committed one. `getDatabases` is mocked so the
 * ledger write succeeds and the publish path runs.
 */

const { databases } = vi.hoisted(() => ({
  databases: {
    createDocument: vi.fn(),
    listDocuments: vi.fn(),
  },
}));

vi.mock("./appwrite.config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./appwrite.config")>();
  return {
    ...actual,
    getDatabases: (() => databases) as unknown as typeof actual.getDatabases,
  };
});

afterEach(() => {
  clearTelemetryListeners();
  vi.clearAllMocks();
});

const params = {
  action: "patient.create",
  resourceType: "patient",
  resourceId: "patient-1",
  actorRole: "patient",
  actorId: "user-1",
  ip: "203.0.113.7",
} as const;

describe("appendAuditEntry telemetry", () => {
  it("publishes the entry once it commits", async () => {
    databases.listDocuments.mockResolvedValue({ total: 0, documents: [] });
    databases.createDocument.mockResolvedValue({});

    const listener = vi.fn();
    subscribeTelemetry(listener);

    const committed = await appendAuditEntry(params);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      type: "audit.entry",
      data: {
        seq: 1,
        action: "patient.create",
        resourceType: "patient",
        resourceId: "patient-1",
        actorRole: "patient",
        actorId: "user-1",
        occurredAt: committed.occurredAt,
      },
    });
  });

  it("does not publish entries that fail to write", async () => {
    databases.listDocuments.mockResolvedValue({ total: 0, documents: [] });
    databases.createDocument.mockRejectedValue(new Error("write failed"));

    const listener = vi.fn();
    subscribeTelemetry(listener);

    await expect(appendAuditEntry(params)).rejects.toThrow("write failed");

    expect(listener).not.toHaveBeenCalled();
  });
});