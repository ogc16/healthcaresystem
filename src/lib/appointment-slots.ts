import { createHash } from "node:crypto";

import { Query } from "node-appwrite";

import type { Appointment } from "@/types/appwrite.types";

import {
  APPOINTMENT_COLLECTION_ID,
  DATABASE_ID,
  getDatabases,
} from "./appwrite.config";

export const APPOINTMENT_DURATION_MINUTES = 30;

/**
 * Deterministic document id for a booking slot.
 *
 * Derived only from `(primaryPhysician, schedule)`: two concurrent booking
 * requests for the same slot compute the same id, so the second insert fails
 * atomically with a 409 instead of racing around `assertNoScheduleConflict`
 * (whose read-then-insert gap is what let a slot be double-booked).
 *
 * A SHA-256 prefix of the physician name keeps distinct physicians from ever
 * collapsing onto the same id no matter how similar their names are, and using
 * the epoch-millisecond schedule means rebooking a freed slot is a genuinely
 * different id. The result stays well under Appwrite's 36-character id limit.
 */
export const appointmentDocumentId = (
  primaryPhysician: string,
  schedule: Date | string
) => {
  const scheduleMs = new Date(schedule).getTime();

  if (Number.isNaN(scheduleMs)) {
    throw new Error("Invalid appointment date");
  }

  const physicianHash = createHash("sha256")
    .update(primaryPhysician)
    .digest("hex")
    .slice(0, 8);

  return `book-${physicianHash}-${scheduleMs}`;
};

export class ScheduleConflictError extends Error {
  readonly primaryPhysician: string;
  readonly conflictingSchedule: string;

  constructor(primaryPhysician: string, conflictingSchedule: string) {
    super(
      `${primaryPhysician} already has an appointment at that time. Please pick another slot.`
    );
    this.name = "ScheduleConflictError";
    this.primaryPhysician = primaryPhysician;
    this.conflictingSchedule = conflictingSchedule;
  }
}

const SLOT_MS = APPOINTMENT_DURATION_MINUTES * 60 * 1000;

/**
 * Two appointments collide when they start less than one slot duration apart.
 * Appwrite's `between` is inclusive on both bounds, so this exact test has to
 * run in JS rather than being pushed into the query.
 */
export const hasSlotOverlap = (
  existing: Date | string | number,
  requested: Date | string | number
) =>
  Math.abs(new Date(existing).getTime() - new Date(requested).getTime()) <
  SLOT_MS;

/**
 * Returns the appointment that overlaps `schedule` for `primaryPhysician`, or
 * null when the slot is free. Cancelled appointments release their slot.
 *
 * The query window is a pre-filter; the exact overlap test is applied in JS
 * because Appwrite's `between` is inclusive on both bounds.
 */
export const findScheduleConflict = async ({
  primaryPhysician,
  schedule,
  excludeAppointmentId,
}: {
  primaryPhysician: string;
  schedule: Date | string;
  excludeAppointmentId?: string;
}) => {
  const requestedAt = new Date(schedule).getTime();

  if (Number.isNaN(requestedAt)) {
    throw new Error("Invalid appointment date");
  }

  const { documents } = await getDatabases().listDocuments<Appointment>(
    DATABASE_ID!,
    APPOINTMENT_COLLECTION_ID!,
    [
      Query.equal("primaryPhysician", [primaryPhysician]),
      Query.between(
        "schedule",
        new Date(requestedAt - SLOT_MS).toISOString(),
        new Date(requestedAt + SLOT_MS).toISOString()
      ),
      Query.notEqual("status", "cancelled"),
    ]
  );

  const conflict = documents.find((appointment) => {
    if (appointment.$id === excludeAppointmentId) return false;

    return hasSlotOverlap(appointment.schedule, requestedAt);
  });

  return conflict ?? null;
};

export const assertNoScheduleConflict = async (params: {
  primaryPhysician: string;
  schedule: Date | string;
  excludeAppointmentId?: string;
}) => {
  const conflict = await findScheduleConflict(params);

  if (conflict) {
    throw new ScheduleConflictError(
      params.primaryPhysician,
      new Date(conflict.schedule).toISOString()
    );
  }
};