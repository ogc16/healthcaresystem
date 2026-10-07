import { afterEach, describe, expect, it } from "vitest";

import {
  OPTIONAL_ENV,
  REQUIRED_ENV,
  env,
  parseEnv,
  validateEnv,
} from "./env";

const ALL_KEYS = [
  ...REQUIRED_ENV,
  ...OPTIONAL_ENV,
  "SENTRY_TELEMETRY",
  "STRICT_ENV",
];

const snapshot = new Map(ALL_KEYS.map((name) => [name, process.env[name]]));

const restore = () => {
  for (const [name, value] of snapshot) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
};

const clearAll = () => {
  for (const name of ALL_KEYS) delete process.env[name];
};

const setComplete = () => {
  process.env.NEXT_PUBLIC_ENDPOINT = "https://appwrite.example.com/v1";
  process.env.PROJECT_ID = "project";
  process.env.API_KEY = "secret-api-key-0123456789abcdef0123456789";
  process.env.DATABASE_ID = "db";
  process.env.PATIENT_COLLECTION_ID = "patients";
  process.env.DOCTOR_COLLECTION_ID = "doctors";
  process.env.APPOINTMENT_COLLECTION_ID = "appointments";
  process.env.AUDIT_COLLECTION_ID = "audit";
  process.env.SMS_OUTBOX_COLLECTION_ID = "sms_outbox";
  process.env.NEXT_PUBLIC_BUCKET_ID = "bucket";
  process.env.PHI_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  process.env.ADMIN_PASSKEY = "123456";
  process.env.SESSION_SECRET = "a-32-character-secret-0123456789abcdef";
};

afterEach(restore);

describe("parseEnv", () => {
  it("reports every required variable as missing when nothing is set", () => {
    clearAll();

    const { missing } = parseEnv(process.env);

    expect(missing).toEqual(REQUIRED_ENV);
  });

  it("treats an empty string as missing", () => {
    clearAll();
    process.env.PROJECT_ID = "";

    const { missing, values } = parseEnv(process.env);

    expect(missing).toContain("PROJECT_ID");
    expect(values.PROJECT_ID).toBeUndefined();
  });

  it("does not report absent optional variables as missing", () => {
    clearAll();

    const { missing } = parseEnv(process.env);

    for (const name of OPTIONAL_ENV) {
      expect(missing).not.toContain(name);
    }
  });

  it("keeps valid values for every required variable", () => {
    clearAll();
    setComplete();

    const { missing, invalid, values } = parseEnv(process.env);

    expect(missing).toEqual([]);
    expect(invalid).toEqual([]);
    expect(values).toMatchObject({
      NEXT_PUBLIC_ENDPOINT: "https://appwrite.example.com/v1",
      PROJECT_ID: "project",
      SESSION_SECRET: "a-32-character-secret-0123456789abcdef",
    });
  });

  it("accepts a plain-http endpoint that points at localhost", () => {
    clearAll();
    process.env.NEXT_PUBLIC_ENDPOINT = "http://localhost:7800/v1";

    const { invalid } = parseEnv(process.env);

    expect(invalid).toEqual([]);
  });

  it("rejects plain-http endpoints that are not localhost", () => {
    clearAll();
    process.env.NEXT_PUBLIC_ENDPOINT = "http://appwrite.example.com/v1";

    const { invalid } = parseEnv(process.env);

    expect(invalid).toContainEqual(
      expect.objectContaining({ name: "NEXT_PUBLIC_ENDPOINT" })
    );
  });

  it("rejects a malformed endpoint", () => {
    clearAll();
    process.env.NEXT_PUBLIC_ENDPOINT = "not a url";

    const { invalid } = parseEnv(process.env);

    expect(invalid).toContainEqual(
      expect.objectContaining({ name: "NEXT_PUBLIC_ENDPOINT" })
    );
  });

  it("rejects a session secret shorter than 32 characters", () => {
    clearAll();
    process.env.SESSION_SECRET = "too-short";

    const { invalid } = parseEnv(process.env);

    expect(invalid).toContainEqual(
      expect.objectContaining({ name: "SESSION_SECRET" })
    );
  });

  it("rejects a placeholder-style API key", () => {
    clearAll();
    process.env.API_KEY = "shorter-than-twenty";

    const { invalid } = parseEnv(process.env);

    expect(invalid).toContainEqual(
      expect.objectContaining({ name: "API_KEY" })
    );
  });

  it("rejects a malformed Twilio phone number and SID", () => {
    clearAll();
    process.env.TWILIO_PHONE_NUMBER = "555-1234";
    process.env.TWILIO_ACCOUNT_SID = "not-a-sid";

    const { invalid } = parseEnv(process.env);

    expect(invalid).toContainEqual(
      expect.objectContaining({ name: "TWILIO_PHONE_NUMBER" })
    );
    expect(invalid).toContainEqual(
      expect.objectContaining({ name: "TWILIO_ACCOUNT_SID" })
    );
  });

  it("rejects a PHI encryption key that is not 64 hex characters", () => {
    clearAll();
    process.env.PHI_ENCRYPTION_KEY = "too-short";

    const { invalid } = parseEnv(process.env);

    expect(invalid).toContainEqual(
      expect.objectContaining({ name: "PHI_ENCRYPTION_KEY" })
    );
  });

  it("treats an absent audit collection id as missing", () => {
    clearAll();

    const { missing } = parseEnv(process.env);

    expect(missing).toContain("AUDIT_COLLECTION_ID");
  });

  it("treats an absent sms outbox collection id as missing", () => {
    clearAll();

    const { missing } = parseEnv(process.env);

    expect(missing).toContain("SMS_OUTBOX_COLLECTION_ID");
  });

  it("rejects a max-attempts value outside 1..30", () => {
    clearAll();
    process.env.SMS_MAX_ATTEMPTS = "0";

    const { invalid } = parseEnv(process.env);

    expect(invalid).toContainEqual(
      expect.objectContaining({ name: "SMS_MAX_ATTEMPTS" })
    );
  });

  it("rejects a short CRON_SECRET when one is set", () => {
    clearAll();
    process.env.CRON_SECRET = "short";

    const { invalid } = parseEnv(process.env);

    expect(invalid).toContainEqual(
      expect.objectContaining({ name: "CRON_SECRET" })
    );
  });

  it("treats an absent Gemini key as an unset optional", () => {
    clearAll();

    const { missing, invalid, values } = parseEnv(process.env);

    expect(missing).not.toContain("GEMINI_API_KEY");
    expect(invalid).toEqual([]);
    expect(values.GEMINI_API_KEY).toBeUndefined();
  });

  it("applies the default Gemini model when the variable is absent", () => {
    clearAll();

    const { values } = parseEnv(process.env);

    expect(values.GEMINI_MODEL).toBe("gemini-2.5-flash");
  });

  it("rejects a blank Gemini model when one is set", () => {
    clearAll();
    process.env.GEMINI_MODEL = " ";

    const { invalid } = parseEnv(process.env);

    expect(invalid).toContainEqual(
      expect.objectContaining({ name: "GEMINI_MODEL" })
    );
  });

  it("applies the telemetry default when the variable is absent", () => {
    clearAll();

    const { values } = parseEnv(process.env);

    expect(values.SENTRY_TELEMETRY).toBe("false");
  });

  it("reports a present value that fails the telemetry enum", () => {
    clearAll();
    process.env.SENTRY_TELEMETRY = "yes";

    const { invalid } = parseEnv(process.env);

    expect(invalid).toContainEqual(
      expect.objectContaining({ name: "SENTRY_TELEMETRY" })
    );
  });
});

describe("env accessor", () => {
  it("reads live values rather than an import-time snapshot", () => {
    clearAll();
    expect(env.PROJECT_ID).toBe("");

    process.env.PROJECT_ID = "live-value";
    expect(env.PROJECT_ID).toBe("live-value");
  });

  it("reads a missing variable as an empty string", () => {
    clearAll();

    expect(env.SESSION_SECRET).toBe("");
  });

  it("applies the telemetry default", () => {
    clearAll();

    expect(env.SENTRY_TELEMETRY).toBe("false");
  });

  it("applies the Gemini model default", () => {
    clearAll();

    expect(env.GEMINI_MODEL).toBe("gemini-2.5-flash");
  });
});

describe("validateEnv", () => {
  it("does nothing unless STRICT_ENV is true", () => {
    clearAll();
    delete process.env.STRICT_ENV;

    expect(() => validateEnv()).not.toThrow();
  });

  it("throws an aggregate of every problem when strict mode is on", () => {
    clearAll();
    process.env.STRICT_ENV = "true";

    let thrown = "";

    try {
      validateEnv();
    } catch (error) {
      thrown = error instanceof Error ? error.message : "";
    }

    expect(thrown).toContain("missing NEXT_PUBLIC_ENDPOINT");
    expect(thrown).toContain("missing SESSION_SECRET");
  });

  it("reports invalid values alongside missing ones", () => {
    clearAll();
    process.env.STRICT_ENV = "true";
    process.env.NEXT_PUBLIC_ENDPOINT = "http://appwrite.example.com/v1";

    let thrown = "";

    try {
      validateEnv();
    } catch (error) {
      thrown = error instanceof Error ? error.message : "";
    }

    expect(thrown).toContain("NEXT_PUBLIC_ENDPOINT");
  });

  it("passes silently when the environment is complete and valid", () => {
    clearAll();
    setComplete();
    process.env.STRICT_ENV = "true";

    expect(() => validateEnv()).not.toThrow();
  });
});