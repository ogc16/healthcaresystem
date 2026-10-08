import type { Databases, Messaging, Storage } from "node-appwrite";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  claimDueJobs,
  drainJobs,
  enqueueJob,
  jobMaxAttempts,
  nextJobRetryDelayMs,
  registerJobHandler,
} from "./job-queue";

const MINUTE = 60 * 1000;

const fakeDatabase = () => {
  const createDocument = vi.fn();
  const updateDocument = vi.fn();
  const listDocuments = vi.fn();
  const getDocument = vi.fn();
  return { createDocument, updateDocument, listDocuments, getDocument };
};

const fakeStorage = () => ({ createFile: vi.fn() });

const fakeMessaging = () => ({ createSms: vi.fn() });

const asDatabases = (fake: ReturnType<typeof fakeDatabase>) =>
  fake as unknown as Databases;

const asStorage = (fake: ReturnType<typeof fakeStorage>) =>
  fake as unknown as Storage;

const asMessaging = (fake: ReturnType<typeof fakeMessaging>) =>
  fake as unknown as Messaging;

const jobDoc = (overrides = {}) => ({
  $id: "job-1",
  $databaseId: "db",
  $collectionId: "job_queue",
  $createdAt: "2026-01-01T09:00:00.000Z",
  $updatedAt: "2026-01-01T09:00:00.000Z",
  $permissions: [] as string[],
  type: "test.ok",
  payload: "{}",
  status: "pending",
  attempts: 0,
  nextAttemptAt: "2026-01-01T08:00:00.000Z",
  claimedAt: "",
  lastError: "",
  result: "",
  completedAt: "",
  ...overrides,
});

const now = new Date("2026-01-01T10:00:00.000Z");

describe("nextJobRetryDelayMs", () => {
  it("backs off exponentially from the base", () => {
    expect(nextJobRetryDelayMs(1)).toBe(60_000);
    expect(nextJobRetryDelayMs(2)).toBe(120_000);
    expect(nextJobRetryDelayMs(3)).toBe(240_000);
  });

  it("caps the delay", () => {
    expect(nextJobRetryDelayMs(100)).toBe(24 * 60 * MINUTE);
  });
});

describe("jobMaxAttempts", () => {
  it("falls back to the default when unset or invalid", () => {
    delete process.env.JOB_MAX_ATTEMPTS;
    expect(jobMaxAttempts()).toBe(5);

    process.env.JOB_MAX_ATTEMPTS = "not-a-number";
    expect(jobMaxAttempts()).toBe(5);
  });

  it("reads a configured value", () => {
    process.env.JOB_MAX_ATTEMPTS = "3";
    expect(jobMaxAttempts()).toBe(3);
  });
});

describe("enqueueJob", () => {
  it("writes a pending job with a serialized payload", async () => {
    const databases = fakeDatabase();
    databases.createDocument.mockResolvedValue({ $id: "job-1" });

    process.env.DATABASE_ID = "db";
    process.env.JOB_QUEUE_COLLECTION_ID = "job_queue";

    const queued = await enqueueJob(
      { type: "invoice.generate", payload: { appointmentId: "a1" } },
      { databases: asDatabases(databases) }
    );

    expect(queued).toBe(true);
    const [databaseId, collectionId, documentId, data] =
      databases.createDocument.mock.calls[0];
    expect(databaseId).toBeTruthy();
    expect(collectionId).toBe("job_queue");
    expect(documentId).toBeTruthy();
    expect(data).toMatchObject({
      type: "invoice.generate",
      payload: JSON.stringify({ appointmentId: "a1" }),
      status: "pending",
      attempts: 0,
    });
  });

  it("treats a deterministic-id collision as already queued", async () => {
    const databases = fakeDatabase();
    databases.createDocument.mockRejectedValue({
      type: "document_already_exists",
      status: 409,
    });

    process.env.DATABASE_ID = "db";
    process.env.JOB_QUEUE_COLLECTION_ID = "job_queue";

    const queued = await enqueueJob(
      { type: "invoice.generate", payload: {}, jobId: "invoice-a1" },
      { databases: asDatabases(databases) }
    );

    expect(queued).toBe(false);
    expect(databases.createDocument).toHaveBeenCalledWith(
      expect.anything(),
      "job_queue",
      "invoice-a1",
      expect.anything()
    );
  });

  it("swallows other failures so callers are never blocked by the queue", async () => {
    const databases = fakeDatabase();
    databases.createDocument.mockRejectedValue(new Error("provider down"));
    const consoleSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    delete process.env.JOB_QUEUE_COLLECTION_ID;

    await expect(
      enqueueJob(
        { type: "invoice.generate", payload: {} },
        { databases: asDatabases(databases) }
      )
    ).resolves.toBe(false);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to enqueue job"),
      expect.any(Error)
    );
  });
});

describe("claimDueJobs", () => {
  it("claims due pending jobs and expired leases, excluding in-flight ones", async () => {
    const databases = fakeDatabase();
    databases.listDocuments
      .mockResolvedValueOnce({ total: 1, documents: [jobDoc()] })
      .mockResolvedValueOnce({ total: 1, documents: [jobDoc({ $id: "job-2" })] });

    process.env.DATABASE_ID = "db";
    process.env.JOB_QUEUE_COLLECTION_ID = "job_queue";

    const claimed = await claimDueJobs({
      databases: asDatabases(databases),
      limit: 10,
      now,
      leaseMs: 5 * MINUTE,
    });

    expect(claimed.map((job) => job.$id)).toEqual(["job-1", "job-2"]);

    // Both the pending fetch and the stale-lease fetch limit to the batch size.
    const pendingQueries = (databases.listDocuments.mock.calls[0][2] as string[]).map(
      (q) => JSON.parse(q)
    );
    expect(pendingQueries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: "status" }),
        expect.objectContaining({ attribute: "nextAttemptAt" }),
        expect.objectContaining({ attribute: "$createdAt" }),
      ])
    );
    const staleQueries = (databases.listDocuments.mock.calls[1][2] as string[]).map(
      (q) => JSON.parse(q)
    );
    expect(staleQueries).toEqual(
      expect.arrayContaining([expect.objectContaining({ attribute: "claimedAt" })])
    );

    // Claims stamp both rows as processing before any handler runs.
    expect(databases.updateDocument).toHaveBeenCalledTimes(2);
    const [, , id, data] = databases.updateDocument.mock.calls[0];
    expect(id).toBe("job-1");
    expect(data).toMatchObject({
      status: "processing",
      claimedAt: now.toISOString(),
    });
  });
});

describe("drainJobs", () => {
  beforeEach(() => {
    registerJobHandler("test.ok", async () => ({ result: JSON.stringify({ ok: true }) }));
  });

  it("runs the handler and marks the job done with its result", async () => {
    const databases = fakeDatabase();
    const storage = fakeStorage();
    const messaging = fakeMessaging();
    const audit = vi.fn();
    databases.listDocuments
      .mockResolvedValueOnce({ total: 1, documents: [jobDoc()] })
      .mockResolvedValueOnce({ total: 0, documents: [] });
    databases.updateDocument.mockResolvedValue({});

    process.env.DATABASE_ID = "db";
    process.env.JOB_QUEUE_COLLECTION_ID = "job_queue";
    process.env.JOB_MAX_ATTEMPTS = "3";

    const results = await drainJobs({
      databases: asDatabases(databases),
      storage: asStorage(storage),
      messaging: asMessaging(messaging),
      audit,
      now,
    });

    expect(results).toEqual([
      { $id: "job-1", type: "test.ok", outcome: "done", attempts: 0, result: '{"ok":true}' },
    ]);
    const [, , id, data] = databases.updateDocument.mock.calls.at(-1)!;
    expect(id).toBe("job-1");
    expect(data).toMatchObject({
      status: "done",
      result: '{"ok":true}',
      completedAt: now.toISOString(),
    });
  });

  it("gives handlers the queue context they need", async () => {
    const seen = { ctx: null as unknown };
    registerJobHandler("test.ctx", async (_job, ctx) => {
      seen.ctx = {
        now: ctx.now,
        hasStorage: typeof ctx.storage.createFile === "function",
        hasMessaging: typeof ctx.messaging.createSms === "function",
        hasAudit: typeof ctx.audit === "function",
      };
      return { result: "" };
    });

    const databases = fakeDatabase();
    databases.listDocuments
      .mockResolvedValueOnce({ total: 1, documents: [jobDoc({ type: "test.ctx" })] })
      .mockResolvedValueOnce({ total: 0, documents: [] });
    databases.updateDocument.mockResolvedValue({});

    process.env.DATABASE_ID = "db";
    process.env.JOB_QUEUE_COLLECTION_ID = "job_queue";

    await drainJobs({
      databases: asDatabases(databases),
      storage: asStorage(fakeStorage()),
      messaging: asMessaging(fakeMessaging()),
      audit: vi.fn(),
      now,
    });

    expect(seen.ctx).toEqual({
      now,
      hasStorage: true,
      hasMessaging: true,
      hasAudit: true,
    });
  });

  it("schedules a retry with backoff when the handler throws", async () => {
    registerJobHandler("test.bomb", async () => {
      throw new Error("boom");
    });

    const databases = fakeDatabase();
    databases.listDocuments
      .mockResolvedValueOnce({ total: 1, documents: [jobDoc({ type: "test.bomb" })] })
      .mockResolvedValueOnce({ total: 0, documents: [] });
    databases.updateDocument.mockResolvedValue({});

    process.env.DATABASE_ID = "db";
    process.env.JOB_QUEUE_COLLECTION_ID = "job_queue";
    process.env.JOB_MAX_ATTEMPTS = "3";

    const results = await drainJobs({
      databases: asDatabases(databases),
      storage: asStorage(fakeStorage()),
      messaging: asMessaging(fakeMessaging()),
      audit: vi.fn(),
      now,
    });

    expect(results).toEqual([
      { $id: "job-1", type: "test.bomb", outcome: "retry", attempts: 1, result: "" },
    ]);
    const [, , , data] = databases.updateDocument.mock.calls.at(-1)!;
    expect(data).toMatchObject({
      status: "pending",
      attempts: 1,
      lastError: "boom",
      nextAttemptAt: "2026-01-01T10:01:00.000Z",
    });
  });

  it("marks a job failed when attempts reach the maximum", async () => {
    registerJobHandler("test.bomb", async () => {
      throw new Error("boom");
    });

    const databases = fakeDatabase();
    databases.listDocuments
      .mockResolvedValueOnce({
        total: 1,
        documents: [jobDoc({ type: "test.bomb", attempts: 2 })],
      })
      .mockResolvedValueOnce({ total: 0, documents: [] });
    databases.updateDocument.mockResolvedValue({});

    process.env.DATABASE_ID = "db";
    process.env.JOB_QUEUE_COLLECTION_ID = "job_queue";
    process.env.JOB_MAX_ATTEMPTS = "3";

    const results = await drainJobs({
      databases: asDatabases(databases),
      storage: asStorage(fakeStorage()),
      messaging: asMessaging(fakeMessaging()),
      audit: vi.fn(),
      now,
    });

    expect(results).toEqual([
      { $id: "job-1", type: "test.bomb", outcome: "failed", attempts: 3, result: "" },
    ]);
    const [, , , data] = databases.updateDocument.mock.calls.at(-1)!;
    expect(data.status).toBe("failed");
  });

  it("fails a job with no registered handler instead of dropping it", async () => {
    const databases = fakeDatabase();
    databases.listDocuments
      .mockResolvedValueOnce({ total: 1, documents: [jobDoc({ type: "ghost" })] })
      .mockResolvedValueOnce({ total: 0, documents: [] });
    databases.updateDocument.mockResolvedValue({});

    process.env.DATABASE_ID = "db";
    process.env.JOB_QUEUE_COLLECTION_ID = "job_queue";
    process.env.JOB_MAX_ATTEMPTS = "3";

    const results = await drainJobs({
      databases: asDatabases(databases),
      storage: asStorage(fakeStorage()),
      messaging: asMessaging(fakeMessaging()),
      audit: vi.fn(),
      now,
    });

    expect(results[0]).toMatchObject({ outcome: "retry", attempts: 1 });
    const [, , , data] = databases.updateDocument.mock.calls.at(-1)!;
    expect(data.lastError).toContain('No handler registered for job type "ghost"');
  });
});