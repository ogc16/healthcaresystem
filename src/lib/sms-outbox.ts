import * as sdk from "node-appwrite";

import type { SmsOutbox } from "@/types/appwrite.types";

import { getDatabases, getMessaging } from "./appwrite.config";
import { env } from "./env";

export const SMS_OUTBOX_DRAIN_LIMIT = 10;
export const SMS_MAX_ATTEMPTS_DEFAULT = 5;
export const SMS_BACKOFF_BASE_MS = 15 * 1000;
export const SMS_BACKOFF_CAP_MS = 24 * 60 * 60 * 1000;

export const smsMaxAttempts = () => {
  const parsed = Number.parseInt(env.SMS_MAX_ATTEMPTS, 10);

  return Number.isInteger(parsed) && parsed >= 1
    ? parsed
    : SMS_MAX_ATTEMPTS_DEFAULT;
};

/**
 * Backoff between delivery attempts, in milliseconds. 1-based: the first
 * retry waits `baseMs`, the second `2*baseMs`, and so on, capped at `capMs`
 * so a long-dead provider does not schedule retries into next month.
 */
export const nextSmsRetryDelayMs = (
  attempt: number,
  baseMs = SMS_BACKOFF_BASE_MS,
  capMs = SMS_BACKOFF_CAP_MS
) => Math.min(baseMs * 2 ** (attempt - 1), capMs);

type SmsOutboxDeps = {
  databases?: sdk.Databases;
  messaging?: sdk.Messaging;
};

/**
 * Queues a message instead of sending it inline. Best-effort like
 * `recordAudit`: a failing provider must never take the scheduling update that
 * produced the notification down with it — booking still succeeds, and the
 * drain cron retries the message later.
 */
export const enqueueSms = async (
  { userId, content }: { userId: string; content: string },
  deps: SmsOutboxDeps = {}
) => {
  const databases = deps.databases ?? getDatabases();

  // Read live rather than from a frozen import: `appwrite.config` snapshots
  // env values, which breaks the injectable-unit-test story and would hide a
  // runtime-reconfigured id.
  const collectionId = env.SMS_OUTBOX_COLLECTION_ID;

  try {
    if (!collectionId) {
      throw new Error(
        "Missing required environment variable SMS_OUTBOX_COLLECTION_ID. See .env.example."
      );
    }

    await databases.createDocument(
      env.DATABASE_ID,
      collectionId,
      sdk.ID.unique(),
      {
        userId,
        content,
        status: "pending",
        attempts: 0,
        nextAttemptAt: new Date().toISOString(),
        lastError: "",
      }
    );
  } catch (error) {
    console.error("Failed to queue SMS for recipient:", error);
  }
};

export type SmsDrainResult = Array<{
  $id: string;
  outcome: "sent" | "retry" | "failed";
  attempts: number;
}>;

/**
 * Drains the outbox queue for one run of the notification cron.
 *
 * Fetches the oldest `pending` messages whose backoff window has elapsed and
 * tries each in order. A success marks the message `sent`; a failure records
 * the attempt count, stamps the next retry time with capped exponential
 * backoff, and flips the message to `failed` once `SMS_MAX_ATTEMPTS` is
 * reached.
 *
 * Runs within a single request, so a crash between send and the status write
 * can re-send a message (at-least-once semantics). That is the correct trade:
 * a duplicate SMS is an annoyance, a lost confirmation is a missed
 * appointment.
 */
export const drainSmsOutbox = async ({
  databases = getDatabases(),
  messaging = getMessaging(),
  limit = SMS_OUTBOX_DRAIN_LIMIT,
  now = new Date(),
}: {
  databases?: sdk.Databases;
  messaging?: sdk.Messaging;
  limit?: number;
  now?: Date;
} = {}): Promise<SmsDrainResult> => {
  // Read live rather than from a frozen import (see `enqueueSms`).
  const collectionId = env.SMS_OUTBOX_COLLECTION_ID;
  const maxAttempts = smsMaxAttempts();

  if (!collectionId) {
    throw new Error(
      "Missing required environment variable SMS_OUTBOX_COLLECTION_ID. See .env.example."
    );
  }

  const { documents } = await databases.listDocuments<SmsOutbox>(
    env.DATABASE_ID,
    collectionId,
    [
      sdk.Query.equal("status", ["pending"]),
      sdk.Query.lessThanEqual("nextAttemptAt", now.toISOString()),
      sdk.Query.orderAsc("$createdAt"),
      sdk.Query.limit(limit),
    ]
  );

  const results: SmsDrainResult = [];

  for (const doc of documents) {
    try {
      await messaging.createSms(
        sdk.ID.unique(),
        doc.content,
        [],
        [doc.userId]
      );
      await databases.updateDocument(env.DATABASE_ID, collectionId, doc.$id, {
        status: "sent",
      });
      results.push({
        $id: doc.$id,
        outcome: "sent",
        attempts: doc.attempts,
      });
    } catch (error) {
      const attempts = doc.attempts + 1;
      const status = attempts >= maxAttempts ? "failed" : "pending";

      await databases.updateDocument(env.DATABASE_ID, collectionId, doc.$id, {
        attempts,
        status,
        lastError: error instanceof Error ? error.message : String(error),
        nextAttemptAt: new Date(
          now.getTime() + nextSmsRetryDelayMs(attempts)
        ).toISOString(),
      });
      results.push({
        $id: doc.$id,
        outcome: status === "failed" ? "failed" : "retry",
        attempts,
      });
    }
  }

  return results;
};