import { NextResponse } from "next/server";

import { isAdminSession } from "@/lib/auth/guards";
import { subscribeTelemetry } from "@/lib/telemetry";
import type { TelemetryEnvelope } from "@/lib/telemetry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Admin-only Server-Sent Events stream of live ledger activity.
 *
 * The client opens this with a plain EventSource (the admin session cookie
 * authenticates it, same as the dashboard pages). The stream echoes every
 * committed audit-ledger entry as an `audit.entry` event, prefixed by a `ready`
 * event so the client can distinguish "connected" from "idle". A comment
 * heartbeat every `HEARTBEAT_MS` keeps intermediaries from timing the idle
 * connection out. On disconnect the subscription is removed from the telemetry
 * bus, so abandoned tabs stop consuming events.
 *
 * No PHI crosses this boundary: events carry only the ledger projection the
 * operator console already shows (seq, action, actor, id, timestamp).
 */

const HEARTBEAT_MS = 15_000;
const READY_EVENT = `event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`;
const RETRY = "retry: 3000\n\n";

export const GET = async (request: Request) => {
  if (!(await isAdminSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (payload: string) => {
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          // Stream already closed; the cancel handler performs the cleanup.
        }
      };

      // Subscribe before announcing readiness so a client that has seen
      // `ready` is guaranteed to receive every subsequent event.
      unsubscribe = subscribeTelemetry((event: TelemetryEnvelope) => {
        send(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
      });

      send(RETRY);
      send(READY_EVENT);

      heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);
    },
    cancel() {
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  request.signal.addEventListener("abort", () => {
    unsubscribe?.();
    if (heartbeat) clearInterval(heartbeat);
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
};