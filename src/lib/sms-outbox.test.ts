import type { Databases, Messaging } from "node-appwrite";
import { describe, expect, it, vi } from "vitest";

import {
  drainSmsOutbox,
  enqueueSms,
  nextSmsRetryDelayMs,
  smsMaxAttempts,
} from "./sms-outbox";

const MINUTE = 60 * 1000;

const fakeDatabase = () => {
  const createDocument = vi.fn();
  const updateDocument = vi.fn();
  const listDocuments = vi.fn();
  return { createDocument, updateDocument, listDocuments };
};

const fakeMessaging = () => {
  const createSms = vi.fn();
  return { createSms };
};

const asDatabases = (fake: ReturnType<typeof fakeDatabase>) =>
  fake as unknown as Databases;

const asMessaging = (fake: ReturnType<typeof fakeMessaging>) =>
  fake as unknown as Messaging;

describe("nextSmsRetryDelayMs", () => {
  it("backs off exponentially from the base", () => {
    expect(nextSmsRetryDelayMs(1)).toBe(15_000);
    expect(nextSmsRetryDelayMs(2)).toBe(30_000);
    expect(nextSmsRetryDelayMs(3)).toBe(60_000);
  });

  it("caps the delay", () => {
    expect(nextSmsRetryDelayMs(100)).toBe(24 * 60 * MINUTE);
  });
});

describe("smsMaxAttempts", () => {
  it("falls back to the default when unset or invalid", () => {
    delete process.env.SMS_MAX_ATTEMPTS;
    expect(smsMaxAttempts()).toBe(5);

    process.env.SMS_MAX_ATTEMPTS = "not-a-number";
    expect(smsMaxAttempts()).toBe(5);
  });

  it("reads a configured value", () => {
    process.env.SMS_MAX_ATTEMPTS = "3";
    expect(smsMaxAttempts()).toBe(3);
  });
});

describe("enqueueSms", () => {
  it("writes a pending outbox record", async () => {
    const databases = fakeDatabase();
    databases.createDocument.mockResolvedValue({ $id: "msg-1" });

    process.env.DATABASE_ID = "db";
    process.env.SMS_OUTBOX_COLLECTION_ID = "sms_outbox";

    await enqueueSms(
      { userId: "user-1", content: "hello" },
      { databases: asDatabases(databases) }
    );

    expect(databases.createDocument).toHaveBeenCalledOnce();
    const [databaseId, collectionId, documentId, data] =
      databases.createDocument.mock.calls[0];
    expect(databaseId).toBeTruthy();
    expect(collectionId).toBe("sms_outbox");
    expect(documentId).toBeTruthy();
    expect(data).toMatchObject({
      userId: "user-1",
      content: "hello",
      status: "pending",
      attempts: 0,
      lastError: "",
    });
  });

  it("swallows failures so scheduling is never blocked by SMS", async () => {
    const databases = fakeDatabase();
    databases.createDocument.mockRejectedValue(new Error("provider down"));
    const consoleSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    delete process.env.SMS_OUTBOX_COLLECTION_ID;

    await expect(
      enqueueSms(
        { userId: "user-1", content: "hello" },
        { databases: asDatabases(databases) }
      )
    ).resolves.toBe(false);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to queue SMS"),
      expect.any(Error)
    );
  });

  it("refuses a duplicate when a dedupeKey row already exists", async () => {
    const databases = fakeDatabase();
    databases.listDocuments.mockResolvedValue({
      total: 1,
      documents: [{ $id: "existing" }],
    });

    process.env.DATABASE_ID = "db";
    process.env.SMS_OUTBOX_COLLECTION_ID = "sms_outbox";

    const queued = await enqueueSms(
      { userId: "user-1", content: "hello", dedupeKey: "reminder:a:2026-01-01" },
      { databases: asDatabases(databases) }
    );

    expect(queued).toBe(false);
    expect(databases.createDocument).not.toHaveBeenCalled();
  });

  it("stores dedupeKey on a fresh outbox row", async () => {
    const databases = fakeDatabase();
    databases.listDocuments.mockResolvedValue({ total: 0, documents: [] });
    databases.createDocument.mockResolvedValue({ $id: "msg-1" });

    process.env.DATABASE_ID = "db";
    process.env.SMS_OUTBOX_COLLECTION_ID = "sms_outbox";

    const queued = await enqueueSms(
      { userId: "user-1", content: "hello", dedupeKey: "reminder:a:2026-01-01" },
      { databases: asDatabases(databases) }
    );

    expect(queued).toBe(true);
    const [, , , data] = databases.createDocument.mock.calls[0];
    expect(data.dedupeKey).toBe("reminder:a:2026-01-01");
  });
});

describe("drainSmsOutbox", () => {
  const pendingDoc = (overrides = {}) => ({
    $id: "msg-1",
    $databaseId: "db",
    $collectionId: "sms_outbox",
    $createdAt: "2026-01-01T09:00:00.000Z",
    $updatedAt: "2026-01-01T09:00:00.000Z",
    $permissions: [] as string[],
    $sequence: "1",
    userId: "user-1",
    content: "hello",
    status: "pending",
    attempts: 0,
    nextAttemptAt: "2026-01-01T08:00:00.000Z",
    lastError: "",
    ...overrides,
  });

  const now = new Date("2026-01-01T10:00:00.000Z");

  it("marks a successfully sent message as sent", async () => {
    const databases = fakeDatabase();
    const messaging = fakeMessaging();
    databases.listDocuments.mockResolvedValue({
      total: 1,
      documents: [pendingDoc()],
    });
    messaging.createSms.mockResolvedValue({ $id: "sms-1" });
    databases.updateDocument.mockResolvedValue({});

    process.env.SMS_MAX_ATTEMPTS = "3";
    process.env.SMS_OUTBOX_COLLECTION_ID = "sms_outbox";

    const results = await drainSmsOutbox({
      databases: asDatabases(databases),
      messaging: asMessaging(messaging),
      now,
    });

    expect(results).toEqual([{ $id: "msg-1", outcome: "sent", attempts: 0 }]);
    expect(messaging.createSms).toHaveBeenCalledWith(
      expect.anything(),
      "hello",
      [],
      ["user-1"]
    );
    expect(databases.updateDocument).toHaveBeenCalledWith(
      expect.anything(),
      "sms_outbox",
      "msg-1",
      { status: "sent" }
    );
  });

  it("schedules a retry with backoff when delivery fails", async () => {
    const databases = fakeDatabase();
    const messaging = fakeMessaging();
    databases.listDocuments.mockResolvedValue({
      total: 1,
      documents: [pendingDoc()],
    });
    messaging.createSms.mockRejectedValue(new Error("provider down"));

    process.env.SMS_MAX_ATTEMPTS = "3";
    process.env.SMS_OUTBOX_COLLECTION_ID = "sms_outbox";

    const results = await drainSmsOutbox({
      databases: asDatabases(databases),
      messaging: asMessaging(messaging),
      now,
    });

    expect(results).toEqual([{ $id: "msg-1", outcome: "retry", attempts: 1 }]);
    const [, collectionId, documentId, data] =
      databases.updateDocument.mock.calls[0];
    expect(collectionId).toBe("sms_outbox");
    expect(documentId).toBe("msg-1");
    expect(data).toMatchObject({
      status: "pending",
      attempts: 1,
      nextAttemptAt: "2026-01-01T10:00:15.000Z",
      lastError: "provider down",
    });
  });

  it("marks a message failed when attempts reach the maximum", async () => {
    const databases = fakeDatabase();
    const messaging = fakeMessaging();
    databases.listDocuments.mockResolvedValue({
      total: 1,
      documents: [pendingDoc({ attempts: 2 })],
    });
    messaging.createSms.mockRejectedValue(new Error("provider down"));

    process.env.SMS_MAX_ATTEMPTS = "3";
    process.env.SMS_OUTBOX_COLLECTION_ID = "sms_outbox";

    const results = await drainSmsOutbox({
      databases: asDatabases(databases),
      messaging: asMessaging(messaging),
      now,
    });

    expect(results).toEqual([{ $id: "msg-1", outcome: "failed", attempts: 3 }]);
    const [, , , data] = databases.updateDocument.mock.calls[0];
    expect(data.status).toBe("failed");
  });

  it("queries only pending messages whose backoff has elapsed", async () => {
    const databases = fakeDatabase();
    const messaging = fakeMessaging();
    databases.listDocuments.mockResolvedValue({ total: 0, documents: [] });

    process.env.SMS_MAX_ATTEMPTS = "3";
    process.env.SMS_OUTBOX_COLLECTION_ID = "sms_outbox";

    await drainSmsOutbox({
      databases: asDatabases(databases),
      messaging: asMessaging(messaging),
      limit: 5,
      now,
    });

    expect(databases.listDocuments).toHaveBeenCalledOnce();
    const [, collectionId, queries] = databases.listDocuments.mock.calls[0];
    expect(collectionId).toBe("sms_outbox");
    expect(queries.map((q: string) => JSON.parse(q))).toEqual([
      { method: "equal", attribute: "status", values: ["pending"] },
      {
        method: "lessThanEqual",
        attribute: "nextAttemptAt",
        values: ["2026-01-01T10:00:00.000Z"],
      },
      { method: "orderAsc", attribute: "$createdAt" },
      { method: "limit", values: [5] },
    ]);
  });
});