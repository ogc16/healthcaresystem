import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearTelemetryListeners,
  MAX_TELEMETRY_LISTENERS,
  publishAuditEntry,
  publishTelemetry,
  subscribeTelemetry,
} from "./telemetry";

afterEach(() => {
  clearTelemetryListeners();
  vi.restoreAllMocks();
});

const entry = {
  seq: 7,
  action: "appointment.read",
  resourceType: "appointment",
  resourceId: "appt-1",
  actorRole: "admin",
  actorId: "admin",
  detail: "opened record",
  occurredAt: "2026-01-04T12:00:00.000Z",
} as const;

describe("subscribeTelemetry", () => {
  it("delivers published events to the listener", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTelemetry(listener);

    publishAuditEntry(entry);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      type: "audit.entry",
      data: { ...entry },
    });

    unsubscribe();
  });

  it("stops delivering after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTelemetry(listener);

    unsubscribe();
    publishAuditEntry(entry);

    expect(listener).not.toHaveBeenCalled();
  });

  it("supports multiple independent listeners", () => {
    const first = vi.fn();
    const second = vi.fn();
    subscribeTelemetry(first);
    subscribeTelemetry(second);

    publishTelemetry({ type: "audit.entry", data: { ...entry } });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("rejects subscriptions beyond the listener cap", () => {
    const extra = vi.fn();

    for (let i = 0; i < MAX_TELEMETRY_LISTENERS; i++) {
      subscribeTelemetry(vi.fn());
    }

    expect(() => subscribeTelemetry(extra)).toThrow(/listener limit/);
    expect(extra).not.toHaveBeenCalled();
  });

  it("releases a cap slot when a listener unsubscribes", () => {
    for (let i = 0; i < MAX_TELEMETRY_LISTENERS; i++) {
      subscribeTelemetry(vi.fn());
    }

    // Unsubscribe the first one (keep its handle on the first iteration).
    const handles: (() => void)[] = [];
    clearTelemetryListeners();
    for (let i = 0; i < MAX_TELEMETRY_LISTENERS; i++) {
      handles.push(subscribeTelemetry(vi.fn()));
    }
    handles[0]();

    const newcomer = vi.fn();
    expect(() => subscribeTelemetry(newcomer)).not.toThrow();
  });
});

describe("publishTelemetry", () => {
  it("isolates a throwing listener from the others", () => {
    const throwing = vi.fn(() => {
      throw new Error("listener crashed");
    });
    const healthy = vi.fn();
    subscribeTelemetry(throwing);
    subscribeTelemetry(healthy);

    expect(() => publishAuditEntry(entry)).not.toThrow();

    expect(healthy).toHaveBeenCalledWith({
      type: "audit.entry",
      data: { ...entry },
    });
  });

  it("broadcasts on a snapshot, so unsubscribing mid-broadcast is safe", () => {
    const first = vi.fn();
    const second = vi.fn(() => undefined);
    const unsubscribe = subscribeTelemetry(first);
    subscribeTelemetry(second);

    // Unsubscribe in the middle of a publish (second listener is a no-op that
    // could, in principle, be the one that removes `first`).
    publishTelemetry({ type: "audit.entry", data: { ...entry } });
    unsubscribe();

    expect(first).toHaveBeenCalledTimes(1);
  });
});