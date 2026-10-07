import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { env } from "@/lib/env";
import { drainSmsOutbox } from "@/lib/sms-outbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const secretsMatch = (a: string, b: string) => {
  const aBytes = Buffer.from(a);
  const bBytes = Buffer.from(b);

  return (
    aBytes.length === bBytes.length && timingSafeEqual(aBytes, bBytes)
  );
};

/**
 * Drain endpoint for the SMS outbox. Call from a cron (Appwrite function,
 * GitHub Actions schedule, platform time trigger) with the header:
 *
 *   x-cron-secret: <CRON_SECRET>
 *
 * Disabled unless CRON_SECRET is configured: an open endpoint that sends SMS
 * would be a message-spam and cost vector, so failing closed is the default.
 */
export const GET = async (request: Request) => {
  const secret = env.CRON_SECRET;

  if (!secret) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET is not configured; SMS drain disabled." },
      { status: 503 }
    );
  }

  const presented = request.headers.get("x-cron-secret") ?? "";

  if (!secretsMatch(secret, presented)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const sent = await drainSmsOutbox();

    return NextResponse.json({ ok: true, sent });
  } catch (error) {
    console.error("SMS outbox drain failed:", error);

    return NextResponse.json(
      { ok: false, error: "SMS outbox drain failed" },
      { status: 500 }
    );
  }
};