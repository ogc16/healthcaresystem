import { z } from "zod";

import { env } from "@/lib/env";

/**
 * Patient-message urgency triage built on the Gemini API.
 *
 * This is an optimization, not a control: a clinician is the only authority on
 * whether a message is urgent. The model's verdict is advisory, and every exit
 * path degrades to a non-blocking fallback (`source: "fallback"` with urgency
 * "routine") so a missing key, a rate limit, or a flaky network can never make
 * the caller fail.
 */

export const TRIAGE_URGENCIES = ["urgent", "routine"] as const;
export type TriageUrgency = (typeof TRIAGE_URGENCIES)[number];

/** Characters of patient text sent to the model. Longer messages are truncated. */
export const TRIAGE_MAX_MESSAGE_CHARS = 4_000;
/** The Gemini request aborts after this long so a hung upstream never stalls us. */
export const TRIAGE_TIMEOUT_MS = 10_000;
export const TRIAGE_URL =
  "https://generativelanguage.googleapis.com/v1beta/models";

const triageResponseSchema = z.object({
  urgency: z.enum(TRIAGE_URGENCIES),
  reason: z.string().max(200).optional().default(""),
});

export type TriageResult = {
  urgency: TriageUrgency;
  reason: string;
  /** "model" means Gemini produced the verdict; "fallback" means we degraded. */
  source: "model" | "fallback";
};

export type TriageOptions = {
  /**
   * Injectable for tests. Defaults to `globalThis.fetch` and reads the key and
   * model from the environment at call time, matching the `env` proxy's
   * live-read contract used by the rest of the app.
   */
  fetch?: typeof fetch;
  apiKey?: string;
  model?: string;
};

const fallbackTriage = (reason: string): TriageResult => ({
  urgency: "routine",
  reason,
  source: "fallback",
});

/**
 * Extracts a JSON object out of a model response that may be wrapped in a
 * code fence (```json ... ```) or padded with prose. Returns the raw text
 * between the first "{" and the last "}".
 */
const extractJsonObject = (text: string): string | null => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start === -1 || end === -1 || end < start) return null;

  return text.slice(start, end + 1);
};

/**
 * Classifies a patient message as "urgent" or "routine".
 *
 * Never throws: every failure — missing key, unconfigured model, non-2xx
 * response, malformed or unparseable model output — returns the routine
 * fallback so the caller can carry on.
 */
export const triagePatientMessage = async (
  message: string,
  options: TriageOptions = {}
): Promise<TriageResult> => {
  const apiKey = options.apiKey ?? env.GEMINI_API_KEY;

  if (!apiKey) return fallbackTriage("Gemini API key is not configured");

  const trimmed = message.trim();

  if (trimmed.length === 0) return fallbackTriage("empty message");

  const content =
    trimmed.length > TRIAGE_MAX_MESSAGE_CHARS
      ? trimmed.slice(0, TRIAGE_MAX_MESSAGE_CHARS)
      : trimmed;

  const model = options.model ?? env.GEMINI_MODEL;

  if (!model) return fallbackTriage("no Gemini model configured");

  const httpFetch = options.fetch ?? globalThis.fetch;
  const endpoint = `${TRIAGE_URL}/${encodeURIComponent(model)}:generateContent`;

  const prompt = [
    "You triage a short message sent by a clinic patient.",
    'Reply with JSON only, shaped exactly like: {"urgency":"urgent"|"routine","reason":"one short sentence"}.',
    '"urgent" means the patient needs clinical attention today (e.g. chest pain, serious breathing difficulty, bleeding, severe acute pain, suicidal intent, a medication emergency).',
    '"routine" covers scheduling, test results, refill requests, and non-acute concerns.',
    "Do not invent facts that are not in the message.",
  ].join(" ");

  try {
    const response = await httpFetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: `${prompt}\n\nPatient message:\n${content}` }],
          },
        ],
        generationConfig: { temperature: 0, maxOutputTokens: 120 },
      }),
      signal: AbortSignal.timeout(TRIAGE_TIMEOUT_MS),
    });

    if (!response.ok) {
      return fallbackTriage(`Gemini request failed with status ${response.status}`);
    }

    const payload: unknown = await response.json();
    const candidates = (payload as { candidates?: unknown }).candidates;

    const text = Array.isArray(candidates)
      ? (candidates as { content?: { parts?: { text?: string }[] } }[])
          .flatMap((candidate) => candidate.content?.parts ?? [])
          .map((part) => part.text ?? "")
          .join("")
      : "";

    const rawObject = extractJsonObject(text);

    if (!rawObject) return fallbackTriage("model returned no JSON object");

    const parsed = triageResponseSchema.safeParse(JSON.parse(rawObject));

    if (!parsed.success) return fallbackTriage("model returned unparseable JSON");

    return {
      urgency: parsed.data.urgency,
      reason: parsed.data.reason,
      source: "model",
    };
  } catch {
    return fallbackTriage("Gemini request failed");
  }
};