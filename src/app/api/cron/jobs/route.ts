import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { env } from "@/lib/env";
import { drainJobs } from "@/lib/job-queue";
import { enqueueReminderDispatch } from "@/lib/jobs/reminder";
import "@/lib/jobs";

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
 * Drain endpoint for the persistent job queue. Call from a cron with:
 *
 *   x-cron-secret: <CRON_SECRET>
 *
 * Each hit seeds today's reminder dispatch (a deterministic-id job, so
 * repeated calls cannot stack rain of dispatches) and then drains up to
 * `JOB_QUEUE_DRAIN_LIMIT` due jobs. Like the SMS drain, it fails closed when
 * CRON_SECRET is unset.
 */
export const GET = async (request: Request) => {
  const secret = env.CRON_SECRET;

  if (!secret) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET is not configured; job queue drain disabled." },
      { status: 503 }
    );
  }

  const presented = request.headers.get("x-cron-secret") ?? "";

  if (!secretsMatch(secret, presented)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    await enqueueReminderDispatch();
    const processed = await drainJobs();

    return NextResponse.json({ ok: true, processed });
  } catch (error) {
    console.error("Job queue drain failed:", error);

    return NextResponse.json(
      { ok: false, error: "Job queue drain failed" },
      { status: 500 }
    );
  }
};