import type { Databases, Messaging } from "node-appwrite";
import { describe, expect, it, vi } from "vitest";

import {
  dispatchAppointmentReminders,
  reminderDedupeKeyFor,
  reminderDispatchJobId,
  reminderSmsBody,
} from "./reminder";

const fakeDatabase = () => {
  const createDocument = vi.fn();
  const updateDocument = vi.fn();
  const listDocuments = vi.fn();
  const getDocument = vi.fn();
  return { createDocument, updateDocument, listDocuments, getDocument };
};

const fakeMessaging = () => ({ createSms: vi.fn() });

const asDatabases = (fake: ReturnType<typeof fakeDatabase>) =>
  fake as unknown as Databases;

const asMessaging = (fake: ReturnType<typeof fakeMessaging>) =>
  fake as unknown as Messaging;

const now = new Date("2026-01-04T09:00:00.000Z");

const appointmentDoc = (overrides = {}) => ({
  $id: "appt-1",
  $databaseId: "db",
  $collectionId: "appointments",
  $createdAt: "2026-01-01T09:00:00.000Z",
  $updatedAt: "2026-01-01T09:00:00.000Z",
  $permissions: [] as string[],
  userId: "user-1",
  patient: "pat-1",
  primaryPhysician: "Evan Peter",
  schedule: "2026-01-05T14:00:00.000Z",
  status: "scheduled",
  reason: "Flu symptoms",
  note: "",
  cancellationReason: "",
  ...overrides,
});

describe("reminderDedupeKeyFor", () => {
  it("is scoped to the appointment and the UTC day", () => {
    expect(reminderDedupeKeyFor("appt-1", now)).toBe(
      "reminder:appt-1:2026-01-04"
    );
  });
});

describe("reminderDispatchJobId", () => {
  it("is one per UTC day", () => {
    expect(reminderDispatchJobId(now)).toBe("reminder-dispatch-2026-01-04");
  });
});

describe("reminderSmsBody", () => {
  it("includes the physician and a readable time", () => {
    const body = reminderSmsBody(appointmentDoc());
    expect(body).toContain("Dr. Evan Peter");
    expect(body).toContain("2026-01-05 14:00");
  });
});

describe("dispatchAppointmentReminders", () => {
  it("enqueues one deduped SMS per due appointment and reports the count", async () => {
    const databases = fakeDatabase();
    const messaging = fakeMessaging();
    databases.listDocuments
      .mockResolvedValueOnce({
        total: 2,
        documents: [
          appointmentDoc(),
          appointmentDoc({ $id: "appt-2", userId: "user-2" }),
        ],
      })
      // each enqueueSms asks the outbox whether it already has a row
      .mockResolvedValue({ total: 0, documents: [] });

    process.env.DATABASE_ID = "db";
    process.env.APPOINTMENT_COLLECTION_ID = "appointments";
    process.env.SMS_OUTBOX_COLLECTION_ID = "sms_outbox";

    const queued = await dispatchAppointmentReminders({
      databases: asDatabases(databases),
      messaging: asMessaging(messaging),
      now,
    });

    expect(queued).toBe(2);
    const createCalls = databases.createDocument.mock.calls;
    expect(createCalls).toHaveLength(2);
    expect(createCalls[0][3]).toMatchObject({
      userId: "user-1",
      status: "pending",
      dedupeKey: "reminder:appt-1:2026-01-04",
    });
    expect(createCalls[1][3].userId).toBe("user-2");

    // The scan asks only for scheduled appointments in the coming day.
    const queries = (databases.listDocuments.mock.calls[0][2] as string[]).map((q) =>
      JSON.parse(q)
    );
    expect(queries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: "status" }),
        expect.objectContaining({ attribute: "schedule" }),
        expect.objectContaining({ method: "greaterThanEqual", attribute: "schedule" }),
        expect.objectContaining({ method: "lessThanEqual", attribute: "schedule" }),
      ])
    );
  });

  it("skips appointments already notified for today", async () => {
    const databases = fakeDatabase();
    const messaging = fakeMessaging();
    databases.listDocuments
      // due appointments query
      .mockResolvedValueOnce({ total: 1, documents: [appointmentDoc()] })
      // dedupe lookup inside enqueueSms finds an existing row
      .mockResolvedValueOnce({ total: 1, documents: [{ $id: "existing" }] });

    process.env.DATABASE_ID = "db";
    process.env.APPOINTMENT_COLLECTION_ID = "appointments";
    process.env.SMS_OUTBOX_COLLECTION_ID = "sms_outbox";

    const queued = await dispatchAppointmentReminders({
      databases: asDatabases(databases),
      messaging: asMessaging(messaging),
      now,
    });

    expect(queued).toBe(0);
    expect(databases.createDocument).not.toHaveBeenCalled();
  });

  it("ignores non-scheduled appointments in the window", async () => {
    const databases = fakeDatabase();
    const messaging = fakeMessaging();
    databases.listDocuments.mockResolvedValue({
      total: 1,
      documents: [appointmentDoc({ $id: "appt-x", status: "pending" })],
    });

    process.env.DATABASE_ID = "db";
    process.env.APPOINTMENT_COLLECTION_ID = "appointments";
    process.env.SMS_OUTBOX_COLLECTION_ID = "sms_outbox";

    const queued = await dispatchAppointmentReminders({
      databases: asDatabases(databases),
      messaging: asMessaging(messaging),
      now,
    });

    expect(queued).toBe(0);
    expect(databases.createDocument).not.toHaveBeenCalled();
  });
});