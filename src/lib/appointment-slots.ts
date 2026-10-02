import { Query } from "node-appwrite";

import type { Appointment } from "@/types/appwrite.types";

import {
  APPOINTMENT_COLLECTION_ID,
  DATABASE_ID,
  databases,
} from "./appwrite.config";

export const APPOINTMENT_DURATION_MINUTES = 30;

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

  const { documents } = await databases.listDocuments(
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

  const conflict = (documents as Appointment[]).find((appointment) => {
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