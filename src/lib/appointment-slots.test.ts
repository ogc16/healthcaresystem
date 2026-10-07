/**
 * Double-booking prevention.
 *
 * `hasSlotOverlap` is the exact test that Appwrite's inclusive `between` query
 * cannot express, so the booking rule lives or dies here. `findScheduleConflict`
 * also validates its date before touching the network, which makes the invalid
 * input case testable without an Appwrite project.
 */
import { describe, expect, it } from "vitest";

import {
  APPOINTMENT_DURATION_MINUTES,
  appointmentDocumentId,
  findScheduleConflict,
  hasSlotOverlap,
  ScheduleConflictError,
} from "./appointment-slots";

const AT = "2026-01-01T10:00:00Z";

const minutesFrom = (iso: string, minutes: number) =>
  new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();

describe("hasSlotOverlap", () => {
  it("treats a 30 minute appointment as the slot length", () => {
    expect(APPOINTMENT_DURATION_MINUTES).toBe(30);
  });

  it("collides on an identical start", () => {
    expect(hasSlotOverlap(AT, AT)).toBe(true);
  });

  it("collides strictly inside the slot", () => {
    expect(hasSlotOverlap(AT, minutesFrom(AT, 1))).toBe(true);
    expect(hasSlotOverlap(AT, minutesFrom(AT, 29))).toBe(true);
  });

  it("does not collide at exactly one slot length", () => {
    expect(hasSlotOverlap(AT, minutesFrom(AT, 30))).toBe(false);
  });

  it("does not collide beyond the slot", () => {
    expect(hasSlotOverlap(AT, minutesFrom(AT, 31))).toBe(false);
    expect(hasSlotOverlap(AT, minutesFrom(AT, 120))).toBe(false);
  });

  it("is symmetric in its arguments", () => {
    expect(hasSlotOverlap(AT, minutesFrom(AT, 10))).toBe(true);
    expect(hasSlotOverlap(minutesFrom(AT, 10), AT)).toBe(true);
  });

  it("does not collide across days", () => {
    expect(hasSlotOverlap(AT, "2026-01-02T10:00:00Z")).toBe(false);
  });

  it("accepts Date objects and epoch milliseconds as well as strings", () => {
    const asDate = new Date(minutesFrom(AT, 10));
    const asNumber = asDate.getTime();

    expect(hasSlotOverlap(AT, asDate)).toBe(true);
    expect(hasSlotOverlap(AT, asNumber)).toBe(true);
    expect(hasSlotOverlap(AT, new Date(minutesFrom(AT, 45)).getTime())).toBe(
      false
    );
  });
});

describe("findScheduleConflict input validation", () => {
  it("rejects an unparseable date before querying Appwrite", async () => {
    await expect(
      findScheduleConflict({
        primaryPhysician: "Dr. Smith",
        schedule: "not-a-date",
      })
    ).rejects.toThrow("Invalid appointment date");
  });
});

describe("ScheduleConflictError", () => {
  const error = new ScheduleConflictError("Dr. Smith", AT);

  it("is an Error", () => {
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ScheduleConflictError");
  });

  it("names the physician and the taken slot", () => {
    expect(error.message).toMatch(/already has an appointment/);
    expect(error.message).toContain("Dr. Smith");
    expect(error.primaryPhysician).toBe("Dr. Smith");
    expect(error.conflictingSchedule).toBe(AT);
  });
});

describe("appointmentDocumentId", () => {
  it("is identical for the same physician and schedule", () => {
    expect(appointmentDocumentId("Dr. Smith", AT)).toBe(
      appointmentDocumentId("Dr. Smith", AT)
    );
  });

  it("is identical for an equivalent Date object", () => {
    expect(appointmentDocumentId("Dr. Smith", AT)).toBe(
      appointmentDocumentId("Dr. Smith", new Date(AT))
    );
  });

  it("differs when the schedule changes", () => {
    expect(appointmentDocumentId("Dr. Smith", AT)).not.toBe(
      appointmentDocumentId("Dr. Smith", minutesFrom(AT, 1))
    );
  });

  it("differs for different physicians at the same time", () => {
    expect(appointmentDocumentId("Dr. Smith", AT)).not.toBe(
      appointmentDocumentId("Dr. Green", AT)
    );
  });

  it("is name-independent for near-identical physician names", () => {
    // Two distinct names must never collapse onto the same id, even when a
    // naive slug would truncate them identically.
    expect(appointmentDocumentId("Dr. Smith-Johnson-Peterson", AT)).not.toBe(
      appointmentDocumentId("Dr. Smith-Johnson-Peterson-Winters", AT)
    );
  });

  it("embeds epoch milliseconds so a freed slot is a fresh id", () => {
    expect(appointmentDocumentId("Dr. Smith", AT)).toContain(
      String(new Date(AT).getTime())
    );
    expect(appointmentDocumentId("Dr. Smith", AT)).toMatch(
      /^book-[0-9a-f]{8}-\d{13}$/
    );
  });

  it("stays within Appwrite's 36 character id limit", () => {
    expect(appointmentDocumentId("Dr. Smith", AT).length).toBeLessThanOrEqual(
      36
    );
  });

  it("rejects an unparseable schedule", () => {
    expect(() => appointmentDocumentId("Dr. Smith", "not-a-date")).toThrow(
      "Invalid appointment date"
    );
  });
});