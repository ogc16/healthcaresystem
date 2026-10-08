import * as sdk from "node-appwrite";

import type { Appointment } from "@/types/appwrite.types";

import { getDatabases } from "../appwrite.config";
import { env } from "../env";
import { enqueueJob, registerJobHandler } from "../job-queue";
import { enqueueSms } from "../sms-outbox";

/**
 * Appointment-reminder fan-out. Once a day the cron enqueues a single
 * `reminder.dispatch` job (see the deterministic job id below, which is what
 * stops repeated cron hits from stacking up dispatches). When drained, that
 * job scans for scheduled appointments in the coming window and writes one
 * `sms_outbox` row per patient. The outbox — not this handler — owns delivery,
 * retries, and final state; this job only owns "who is due a reminder today".
 */

export const REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000;
export const REMINDER_SCAN_LIMIT = 100;

/** One reminder per appointment per UTC day, so a re-run cannot spam. */
export const reminderDedupeKeyFor = (appointmentId: string, day: Date) =>
  `reminder:${appointmentId}:${day.toISOString().slice(0, 10)}`;

export const reminderSmsBody = (
  appointment: Pick<Appointment, "primaryPhysician"> & { schedule: Date | string }
) => {
  const when = new Date(appointment.schedule)
    .toISOString()
    .slice(0, 16)
    .replace("T", " ");

  return `Reminder from CarePulse: your appointment with Dr. ${appointment.primaryPhysician} is on ${when} UTC.`;
};

export const dueReminderAppointments = async ({
  databases,
  now,
  windowMs = REMINDER_WINDOW_MS,
}: {
  databases: sdk.Databases;
  now: Date;
  windowMs?: number;
}) => {
  const { documents } = await databases.listDocuments<Appointment>(
    env.DATABASE_ID,
    env.APPOINTMENT_COLLECTION_ID,
    [
      sdk.Query.equal("status", ["scheduled"]),
      sdk.Query.greaterThanEqual("schedule", now.toISOString()),
      sdk.Query.lessThanEqual(
        "schedule",
        new Date(now.getTime() + windowMs).toISOString()
      ),
      sdk.Query.orderAsc("schedule"),
      sdk.Query.limit(REMINDER_SCAN_LIMIT),
    ]
  );

  return documents.filter((appointment) => appointment.status === "scheduled");
};

/**
 * Scans the due window and enqueues one SMS per appointment, skipping any
 * patient already notified for that appointment today (the outbox carries the
 * `dedupeKey`, so `enqueueSms` refuses to write a duplicate row).
 */
export const dispatchAppointmentReminders = async ({
  databases,
  messaging,
  now,
  windowMs,
}: {
  databases: sdk.Databases;
  messaging: sdk.Messaging;
  now: Date;
  windowMs?: number;
}): Promise<number> => {
  const appointments = await dueReminderAppointments({ databases, now, windowMs });
  let queued = 0;

  for (const appointment of appointments) {
    const wasQueued = await enqueueSms(
      {
        userId: appointment.userId,
        content: reminderSmsBody(appointment),
        dedupeKey: reminderDedupeKeyFor(appointment.$id, now),
      },
      { databases, messaging }
    );

    if (wasQueued) queued += 1;
  }

  return queued;
};

/** One dispatch job per UTC day, so cron over-calls are deduped, not stacked. */
export const reminderDispatchJobId = (day: Date) =>
  `reminder-dispatch-${day.toISOString().slice(0, 10)}`;

/** Best-effort, like `enqueueJob`'s contract: a 409 means already queued today. */
export const enqueueReminderDispatch = async ({
  databases = getDatabases(),
  now = new Date(),
}: {
  databases?: sdk.Databases;
  now?: Date;
} = {}) =>
  enqueueJob(
    {
      type: "reminder.dispatch",
      jobId: reminderDispatchJobId(now),
      payload: {},
    },
    { databases }
  );

registerJobHandler("reminder.dispatch", async (job, ctx) => {
  const queued = await dispatchAppointmentReminders({
    databases: ctx.databases,
    messaging: ctx.messaging,
    now: ctx.now,
  });

  return { result: JSON.stringify({ queued }) };
});