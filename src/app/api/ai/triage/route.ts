import { NextResponse } from "next/server";
import { z } from "zod";

import { triagePatientMessage } from "@/lib/ai/triage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Fast-fail envelope for anything obviously malformed; the message itself is
// capped again in the triage module before it reaches Gemini.
const requestSchema = z.object({
  message: z.string().min(1, "message must not be empty").max(10_000),
});

export const POST = async (request: Request) => {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: parsed.error.issues[0]?.message ?? "invalid request" },
      { status: 400 }
    );
  }

  // Non-blocking by design: an unavailable or unconfigured model degrades to a
  // routine-fallback verdict instead of an error the caller has to handle.
  const result = await triagePatientMessage(parsed.data.message);

  return NextResponse.json({ ok: true, result });
};