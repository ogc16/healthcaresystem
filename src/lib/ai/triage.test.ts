import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TRIAGE_MAX_MESSAGE_CHARS,
  TRIAGE_URL,
  TriageResult,
  triagePatientMessage,
} from "@/lib/ai/triage";
import { env } from "@/lib/env";

const GEMINI_KEY = "test-gemini-key";

const originalEnv: Record<string, string | undefined> = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GEMINI_MODEL: process.env.GEMINI_MODEL,
};

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });

const modelResponse = (text: string) =>
  jsonResponse({
    candidates: [{ content: { parts: [{ text }] } }],
  });

const fakeFetch = (response: Response) =>
  vi.fn(async () => response) as unknown as typeof fetch;

describe("triagePatientMessage", () => {
  it("falls back without throwing when no API key is configured", async () => {
    delete process.env.GEMINI_API_KEY;

    const result = await triagePatientMessage("My chest hurts");

    expect(result).toEqual({
      urgency: "routine",
      source: "fallback",
      reason: "Gemini API key is not configured",
    });
  });

  it("falls back for an empty or blank message", async () => {
    const result = await triagePatientMessage("   ", {
      apiKey: GEMINI_KEY,
    });

    expect(result.source).toBe("fallback");
    expect(result.reason).toBe("empty message");
  });

  it("returns the model verdict for a well-formed response", async () => {
    const flake = fakeFetch(
      modelResponse('{"urgency":"urgent","reason":"chest pain"}')
    );

    const result = await triagePatientMessage("My chest hurts a lot", {
      apiKey: GEMINI_KEY,
      fetch: flake,
    });

    expect(result).toEqual<TriageResult>({
      urgency: "urgent",
      reason: "chest pain",
      source: "model",
    });
  });

  it("orders an urgent message and cites the default reason when absent", async () => {
    const flake = fakeFetch(modelResponse('{"urgency":"routine"}'));

    const result = await triagePatientMessage("Can I move my appointment?", {
      apiKey: GEMINI_KEY,
      fetch: flake,
    });

    expect(result).toEqual<TriageResult>({
      urgency: "routine",
      reason: "",
      source: "model",
    });
  });

  it("parses a JSON object wrapped in a markdown code fence", async () => {
    const flake = fakeFetch(
      modelResponse('```json\n{"urgency":"urgent","reason":"bleeding"}\n```')
    );

    const result = await triagePatientMessage("I am bleeding a lot", {
      apiKey: GEMINI_KEY,
      fetch: flake,
    });

    expect(result).toEqual<TriageResult>({
      urgency: "urgent",
      reason: "bleeding",
      source: "model",
    });
  });

  it("uses the configured model in the request URL", async () => {
    const flake = fakeFetch(modelResponse('{"urgency":"routine","reason":"ok"}'));

    await triagePatientMessage("hello", {
      apiKey: GEMINI_KEY,
      model: "gemini-2.5-flash",
      fetch: flake,
    });

    expect(flake).toHaveBeenCalledWith(
      `${TRIAGE_URL}/gemini-2.5-flash:generateContent`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-goog-api-key": GEMINI_KEY }),
      })
    );
  });

  it("reads the model from the environment when not passed explicitly", async () => {
    process.env.GEMINI_API_KEY = GEMINI_KEY;
    process.env.GEMINI_MODEL = "gemini-2.5-pro";
    const flake = fakeFetch(modelResponse('{"urgency":"routine","reason":"ok"}'));

    await triagePatientMessage("hello", { fetch: flake });

    expect(flake).toHaveBeenCalledWith(
      `${TRIAGE_URL}/gemini-2.5-pro:generateContent`,
      expect.anything()
    );

    expect(env.GEMINI_MODEL).toBe("gemini-2.5-pro");
  });

  it("truncates a message longer than the cap before sending", async () => {
    const longMessage = "a".repeat(TRIAGE_MAX_MESSAGE_CHARS + 500);
    const flake = fakeFetch(modelResponse('{"urgency":"routine","reason":"ok"}'));

    await triagePatientMessage(longMessage, {
      apiKey: GEMINI_KEY,
      fetch: flake,
    });

    const [, init] = (
      flake as unknown as ReturnType<typeof vi.fn>
    ).mock.calls[0] as unknown as [string, RequestInit];

    expect(init.body).toEqual(expect.any(String));

    const sentText = (JSON.parse(init.body as string) as { contents: { parts: { text: string }[] }[] })
      .contents[0].parts[0].text;

    expect(sentText).toContain("a".repeat(TRIAGE_MAX_MESSAGE_CHARS));
    expect(sentText).not.toContain("a".repeat(TRIAGE_MAX_MESSAGE_CHARS + 1));
  });

  it("falls back on a non-2xx Gemini response", async () => {
    const flake = fakeFetch(new Response("rate limited", { status: 429 }));

    const result = await triagePatientMessage("help", {
      apiKey: GEMINI_KEY,
      fetch: flake,
    });

    expect(result).toEqual({
      urgency: "routine",
      source: "fallback",
      reason: "Gemini request failed with status 429",
    });
  });

  it("falls back when the network fetch rejects", async () => {
    const flake = vi.fn(async () => {
      throw new Error("connection reset");
    }) as unknown as typeof fetch;

    const result = await triagePatientMessage("help", {
      apiKey: GEMINI_KEY,
      fetch: flake,
    });

    expect(result).toEqual({
      urgency: "routine",
      source: "fallback",
      reason: "Gemini request failed",
    });
  });

  it("falls back when the model output is not JSON", async () => {
    const flake = fakeFetch(modelResponse("I am unsure how to answer."));

    const result = await triagePatientMessage("help", {
      apiKey: GEMINI_KEY,
      fetch: flake,
    });

    expect(result).toEqual({
      urgency: "routine",
      source: "fallback",
      reason: "model returned no JSON object",
    });
  });

  it("falls back when the model output fails schema validation", async () => {
    const flake = fakeFetch(
      modelResponse('{"urgency":"URGENT","reason":"chest pain"}')
    );

    const result = await triagePatientMessage("help", {
      apiKey: GEMINI_KEY,
      fetch: flake,
    });

    expect(result.source).toBe("fallback");
    expect(result.reason).toBe("model returned unparseable JSON");
  });

  it("falls back when the payload shape is unexpected", async () => {
    const flake = fakeFetch(jsonResponse({ unexpected: true }));

    const result = await triagePatientMessage("help", {
      apiKey: GEMINI_KEY,
      fetch: flake,
    });

    expect(result.source).toBe("fallback");
    expect(result.reason).toBe("model returned no JSON object");
  });
});