"use server";

import { revalidatePath } from "next/cache";
import { ID, Query } from "node-appwrite";

import { Appointment } from "@/types/appwrite.types";

import { assertNoScheduleConflict } from "../appointment-slots";
import {
  APPOINTMENT_COLLECTION_ID,
  DATABASE_ID,
  getDatabases,
  getMessaging,
} from "../appwrite.config";
import {
  assertCanActForPatient,
  getSession,
  isAdminSession,
} from "../auth/guards";
import { formatDateTime, parseStringify } from "../utils";
import { isValidTimeZone } from "../validation";

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

  await assertNoScheduleConflict({
    primaryPhysician: appointment.primaryPhysician,
    schedule: appointment.schedule,
  });

  try {
    const newAppointment = await getDatabases().createDocument(
      DATABASE_ID!,
      APPOINTMENT_COLLECTION_ID!,
      ID.unique(),
      { ...appointment, userId: ownerUserId }
    );

    revalidatePath("/admin");
    return parseStringify(newAppointment);
  } catch (error) {
    console.error("An error occurred while creating a new appointment:", error);
  }
};

//  GET RECENT APPOINTMENTS
export const getRecentAppointmentList = async () => {
  if (!(await isAdminSession())) {
    throw new Error("Unauthorized: admin session required");
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

    return parseStringify(data);
  } catch (error) {
    console.error(
      "An error occurred while retrieving the recent appointments:",
      error
    );
  }
};

//  SEND SMS NOTIFICATION
/**
 * Module-private on purpose.
 *
 * Every export in a `"use server"` file is a network-reachable endpoint. While
 * this one was exported, anyone could post an arbitrary `userId` and `content`
 * and have the app send SMS to that user — a messaging-abuse and cost vector
 * that bypassed the ownership checks on the surrounding actions entirely.
 *
 * Only `updateAppointment` may send SMS, and only to the stored owner of the
 * appointment it just updated.
 */
const sendSMSNotification = async (userId: string, content: string) => {
  try {
    // https://appwrite.io/docs/references/1.5.x/server-nodejs/messaging#createSms
    const message = await getMessaging().createSms(
      ID.unique(),
      content,
      [],
      [userId]
    );
    return parseStringify(message);
  } catch (error) {
    console.error("An error occurred while sending sms:", error);
  }
};

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

    const smsMessage = `Greetings from CarePulse. ${type === "schedule" ? `Your appointment is confirmed for ${formatDateTime(appointment.schedule!, timeZone).dateTime} with Dr. ${appointment.primaryPhysician}` : `We regret to inform that your appointment for ${formatDateTime(appointment.schedule!, timeZone).dateTime} is cancelled. Reason:  ${appointment.cancellationReason}`}.`;

    // Recipient is the record's owner. Taking it from the payload let any caller
    // send SMS to an arbitrary user id.
    await sendSMSNotification(existing.userId, smsMessage);

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

    return parseStringify(appointment);
  } catch (error) {
    console.error("An error occurred while retrieving the appointment:", error);
  }
};
