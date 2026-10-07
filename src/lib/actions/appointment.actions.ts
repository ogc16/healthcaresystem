"use server";

import { revalidatePath } from "next/cache";
import { ID, Query } from "node-appwrite";

import { Appointment } from "@/types/appwrite.types";

import {
  assertNoScheduleConflict,
  appointmentDocumentId,
  ScheduleConflictError,
} from "../appointment-slots";
import {
  APPOINTMENT_COLLECTION_ID,
  DATABASE_ID,
  getDatabases,
  missingAppwriteEnv,
} from "../appwrite.config";
import { recordAudit } from "../audit";
import {
  assertCanActForPatient,
  getSession,
  isAdminSession,
} from "../auth/guards";
import { createThrottle } from "../auth/throttle";
import { enqueueSms } from "../sms-outbox";
import { formatDateTime, parseStringify } from "../utils";
import { isValidTimeZone } from "../validation";

const HOUR_MS = 60 * 60 * 1000;

/** Generous enough for booking several doctors in one sitting, tight enough to stop filling the collection. */
const bookingAttempts = createThrottle({
  limit: 10,
  overallLimit: 200,
  windowMs: HOUR_MS,
});

//  CREATE APPOINTMENT
export const createAppointment = async (
  appointment: CreateAppointmentParams
) => {
  const session = await getSession();

  if (!session) throw new Error("Unauthorized: sign in required");

  // A patient books under their own id. An admin books on someone's behalf, so
  // the payload's userId is only trusted for that role.
  const ownerUserId =
    session.role === "admin" ? appointment.userId : session.userId;

  if (!ownerUserId) throw new Error("Unauthorized: no patient identity");

  // Authenticated but otherwise unbounded: without this, a single session can
  // fill the appointments collection and, via rescheduling, drive SMS spend.
  //
  // Keyed on the acting identity, not the appointment owner, so an admin
  // booking on someone's behalf is charged to the admin rather than to the
  // patient, who did nothing.
  const refused = await bookingAttempts.check(
    session.role === "admin" ? "admin" : `patient:${session.userId}`
  );

  if (refused) throw new Error(refused);

  await assertNoScheduleConflict({
    primaryPhysician: appointment.primaryPhysician,
    schedule: appointment.schedule,
  });

  const slotId = appointmentDocumentId(
    appointment.primaryPhysician,
    appointment.schedule
  );

  const auditAndRespond = async (created: { $id: string }) => {
    await recordAudit({
      action: "appointment.create",
      resourceType: "appointment",
      resourceId: created.$id,
      actorRole: session.role,
      actorId: session.userId ?? "admin",
      detail: `Booked ${appointment.primaryPhysician} at ${appointment.schedule.toISOString()}`,
    });

    revalidatePath("/admin");
    return parseStringify(created);
  };

  try {
    const newAppointment = await getDatabases().createDocument(
      DATABASE_ID!,
      APPOINTMENT_COLLECTION_ID!,
      slotId,
      { ...appointment, userId: ownerUserId }
    );

    return await auditAndRespond(newAppointment);
  } catch (error) {
    // The fast pre-check above already caught the sequential double-booking.
    // A 409 here means the check raced another insert for the same slot: the
    // slot's deterministic id collided atomically, which is the safety net.
    if (isSlotTakenError(error)) {
      const existing = (await getDatabases()
        .getDocument(DATABASE_ID!, APPOINTMENT_COLLECTION_ID!, slotId)
        .catch(() => null)) as Appointment | null;

      if (existing && existing.status !== "cancelled") {
        throw new ScheduleConflictError(
          appointment.primaryPhysician,
          appointment.schedule.toISOString()
        );
      }

      // The slot was released by a cancellation, so booking it again is
      // legitimate. The deterministic id is still in use by the cancelled
      // record, so fall back to a unique one. Two bookings racing in *here*
      // are both allowed to exist only briefly: the admin scheduling step
      // re-checks the slot before confirming either one.
      const retried = await getDatabases().createDocument(
        DATABASE_ID!,
        APPOINTMENT_COLLECTION_ID!,
        ID.unique(),
        { ...appointment, userId: ownerUserId }
      );

      return await auditAndRespond(retried);
    }

    console.error("An error occurred while creating a new appointment:", error);
  }
};

const isSlotTakenError = (error: unknown) => {
  const candidate = error as { type?: string; status?: number };

  return (
    candidate?.type === "document_already_exists" ||
    candidate?.status === 409
  );
};

export type AppointmentSummary = {
  totalCount: number;
  scheduledCount: number;
  pendingCount: number;
  cancelledCount: number;
  documents: Appointment[];
};

/**
 * Why the dashboard might have nothing to show, kept distinct from "there is
 * nothing to show".
 *
 * The previous version returned an empty summary on any failure. That fixed the
 * crash, but it made three different situations render identically as zeroes:
 * a genuinely empty database, an unconfigured server, and Appwrite being
 * unreachable. For a screen an admin uses to judge whether patients have
 * booked, "0 appointments" is a claim, and a silently wrong one is worse than a
 * visible error.
 */
export type RecentAppointments =
  | { status: "ok"; data: AppointmentSummary }
  | { status: "unconfigured"; missing: string[] }
  | { status: "unreachable" };

//  GET RECENT APPOINTMENTS
export const getRecentAppointmentList = async (): Promise<RecentAppointments> => {
  if (!(await isAdminSession())) {
    throw new Error("Unauthorized: admin session required");
  }

  // Checked before the query rather than inferred from a failure, so the user
  // is told which variables to set instead of being handed a stack trace, and
  // so this case logs nothing. An unconfigured deployment is a setup state, not
  // an incident.
  const missing = missingAppwriteEnv();

  if (missing.length > 0) {
    return { status: "unconfigured", missing };
  }

  try {
    const appointments = await getDatabases().listDocuments<Appointment>(
      DATABASE_ID!,
      APPOINTMENT_COLLECTION_ID!,
      [Query.orderDesc("$createdAt")]
    );

    // const scheduledAppointments = (
    //   appointments.documents as Appointment[]
    // ).filter((appointment) => appointment.status === "scheduled");

    // const pendingAppointments = (
    //   appointments.documents as Appointment[]
    // ).filter((appointment) => appointment.status === "pending");

    // const cancelledAppointments = (
    //   appointments.documents as Appointment[]
    // ).filter((appointment) => appointment.status === "cancelled");

    // const data = {
    //   totalCount: appointments.total,
    //   scheduledCount: scheduledAppointments.length,
    //   pendingCount: pendingAppointments.length,
    //   cancelledCount: cancelledAppointments.length,
    //   documents: appointments.documents,
    // };

    const initialCounts = {
      scheduledCount: 0,
      pendingCount: 0,
      cancelledCount: 0,
    };

    const counts = appointments.documents.reduce(
      (acc, appointment) => {
        switch (appointment.status) {
          case "scheduled":
            acc.scheduledCount++;
            break;
          case "pending":
            acc.pendingCount++;
            break;
          case "cancelled":
            acc.cancelledCount++;
            break;
        }
        return acc;
      },
      initialCounts
    );

    const data = {
      totalCount: appointments.total,
      ...counts,
      documents: appointments.documents,
    };

    await recordAudit({
      action: "appointment.list",
      resourceType: "appointment",
      resourceId: "all",
      actorRole: "admin",
      actorId: "admin",
      detail: `Admin listed ${data.totalCount} appointment(s).`,
    });

    return { status: "ok", data: parseStringify(data) };
  } catch (error) {
    // Reached only when configuration is complete but the query itself failed,
    // which is a real incident and worth a stack trace in the log.
    console.error(
      "An error occurred while retrieving the recent appointments:",
      error
    );

    // Still not a zeroed summary. A count of 0 here would be an assertion that
    // no appointments exist, which this failure gives no basis for.
    return { status: "unreachable" };
  }
};

//  SEND SMS NOTIFICATION (via the async outbox)
/**
 * Scheduling is decoupled from SMS delivery: `updateAppointment` only writes
 * an `sms_outbox` record, and a cron (see /api/cron/sms) drains it with
 * exponential backoff. That way a slow or down SMS provider can never block —
 * or silently eat — a scheduling confirmation, and a failed message is retried
 * instead of lost.
 */
const queueSmsNotification = (userId: string, content: string) =>
  enqueueSms({ userId, content });

//  UPDATE APPOINTMENT
export const updateAppointment = async ({
  appointmentId,
  timeZone,
  appointment,
  type,
}: UpdateAppointmentParams) => {
  const session = await getSession();

  if (!session) throw new Error("Unauthorized: sign in required");

  if (!isValidTimeZone(timeZone)) {
    throw new Error(`Invalid time zone: ${timeZone}`);
  }

  // Ownership is checked against the stored record, not the payload, so a
  // caller cannot claim someone else's appointment by echoing their userId.
  const existing = (await getDatabases().getDocument(
    DATABASE_ID!,
    APPOINTMENT_COLLECTION_ID!,
    appointmentId
  )) as Appointment;

  assertCanActForPatient(session, existing.userId);

  // Only a confirmed booking claims a slot; cancellations must never be blocked.
  if (appointment.status === "scheduled") {
    await assertNoScheduleConflict({
      primaryPhysician: appointment.primaryPhysician,
      schedule: appointment.schedule!,
      excludeAppointmentId: appointmentId,
    });
  }

  try {
    // Update appointment to scheduled -> https://appwrite.io/docs/references/cloud/server-nodejs/databases#updateDocument
    const updatedAppointment = await getDatabases().updateDocument(
      DATABASE_ID!,
      APPOINTMENT_COLLECTION_ID!,
      appointmentId,
      appointment
    );

    if (!updatedAppointment) throw Error;

    await recordAudit({
      action: "appointment.update",
      resourceType: "appointment",
      resourceId: appointmentId,
      actorRole: session.role,
      actorId: session.userId ?? "admin",
      detail: `${type === "schedule" ? "Scheduled" : "Cancelled"} for ${appointment.primaryPhysician}`,
    });

    const smsMessage = `Greetings from CarePulse. ${type === "schedule" ? `Your appointment is confirmed for ${formatDateTime(appointment.schedule!, timeZone).dateTime} with Dr. ${appointment.primaryPhysician}` : `We regret to inform that your appointment for ${formatDateTime(appointment.schedule!, timeZone).dateTime} is cancelled. Reason:  ${appointment.cancellationReason}`}.`;

    // Recipient is the record's owner. Taking it from the payload let any caller
    // send SMS to an arbitrary user id.
    await queueSmsNotification(existing.userId, smsMessage);

    revalidatePath("/admin");
    return parseStringify(updatedAppointment);
  } catch (error) {
    console.error("An error occurred while scheduling an appointment:", error);
  }
};

// GET APPOINTMENT
export const getAppointment = async (appointmentId: string) => {
  const session = await getSession();

  if (!session) throw new Error("Unauthorized: sign in required");

  try {
    const appointment = (await getDatabases().getDocument(
      DATABASE_ID!,
      APPOINTMENT_COLLECTION_ID!,
      appointmentId
    )) as Appointment;

    assertCanActForPatient(session, appointment.userId);

    await recordAudit({
      action: "appointment.read",
      resourceType: "appointment",
      resourceId: appointmentId,
      actorRole: session.role,
      actorId: session.userId ?? "admin",
    });

    return parseStringify(appointment);
  } catch (error) {
    console.error("An error occurred while retrieving the appointment:", error);
  }
};
