import { z } from "zod";

/**
 * Central declaration of every environment variable this app reads.
 *
 * Previously each module read `process.env.X` where it needed it, so nothing
 * validated a value: a placeholder left behind by copying `.env.example`
 * failed only when some library rejected it mid-request. This file is the
 * single source of truth for what is required, what shape it must take, and
 * whether the current process is missing anything.
 *
 * Lenient by default: `parseEnv` reports what is wrong instead of throwing, so
 * an unconfigured machine still boots and the admin dashboard can tell the
 * operator which variables to set. `validateEnv` is the strict gate, and it
 * only runs when `STRICT_ENV=true`, so CI and local builds (which have no
 * Appwrite credentials) keep working while a production deployment can opt in
 * to failing at startup instead of at first request.
 */

export type EnvProblem = {
  name: string;
  value: string;
  reason: string;
};

export type ParsedEnv = {
  /** Values that are present, valid, or have a default. */
  values: Record<string, string>;
  /** Required variables that are absent or empty. */
  missing: string[];
  /** Present values that failed validation. */
  invalid: EnvProblem[];
};

type EnvSpec = {
  key: string;
  /** A deployment must set this for the app to be usable. */
  required: boolean;
  schema: z.ZodType<string>;
  default?: string;
};

/** http(s), with plain http only tolerated for localhost dev or mock servers. */
const httpUrl = (allowLocalHttp: boolean) =>
  z
    .string()
    .refine((value) => {
      let url: URL;

      try {
        url = new URL(value);
      } catch {
        return false;
      }

      if (url.protocol === "https:") return true;
      if (url.protocol === "http:") {
        return (
          allowLocalHttp &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        );
      }

      return false;
    }, "must be an http(s) URL, and plain http is only allowed for a localhost dev or mock endpoint");

const identifier = z
  .string()
  .regex(/^\S{1,64}$/, "must be a single word of at most 64 characters");

const e164PhoneNumber = z
  .string()
  .regex(/^\+[1-9]\d{1,14}$/, "must be an E.164 number like +14155552671");

const ENV_SPECS: readonly EnvSpec[] = [
  {
    key: "NEXT_PUBLIC_ENDPOINT",
    required: true,
    schema: httpUrl(true),
  },
  {
    key: "PROJECT_ID",
    required: true,
    schema: identifier,
  },
  {
    key: "API_KEY",
    required: true,
    schema: z.string().min(20, "must be at least 20 characters (looks like a placeholder)"),
  },
  { key: "DATABASE_ID", required: true, schema: identifier },
  { key: "PATIENT_COLLECTION_ID", required: true, schema: identifier },
  { key: "DOCTOR_COLLECTION_ID", required: true, schema: identifier },
  { key: "APPOINTMENT_COLLECTION_ID", required: true, schema: identifier },
  { key: "AUDIT_COLLECTION_ID", required: true, schema: identifier },
  { key: "SMS_OUTBOX_COLLECTION_ID", required: true, schema: identifier },
  { key: "NEXT_PUBLIC_BUCKET_ID", required: true, schema: identifier },
  {
    key: "PHI_ENCRYPTION_KEY",
    required: true,
    schema: z
      .string()
      .regex(
        /^[0-9a-f]{64}$/i,
        "must be 64 hex characters (32 random bytes); generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
      ),
  },
  {
    key: "ADMIN_PASSKEY",
    required: true,
    schema: z.string().min(4, "must be at least 4 characters"),
  },
  {
    key: "SESSION_SECRET",
    required: true,
    schema: z
      .string()
      .min(32, "must be at least 32 characters (prefer 48+ cryptographically random bytes)"),
  },
  { key: "SENTRY_DSN", required: false, schema: httpUrl(false) },
  { key: "NEXT_PUBLIC_SENTRY_DSN", required: false, schema: httpUrl(false) },
  {
    key: "SENTRY_ORG",
    required: false,
    schema: z.string().min(1, "must not be blank"),
  },
  {
    key: "SENTRY_PROJECT",
    required: false,
    schema: z.string().min(1, "must not be blank"),
  },
  {
    key: "SENTRY_AUTH_TOKEN",
    required: false,
    schema: z.string().min(32, "looks like a placeholder"),
  },
  {
    key: "SENTRY_TELEMETRY",
    required: false,
    default: "false",
    schema: z.enum(["true", "false"]),
  },
  {
    key: "TWILIO_ACCOUNT_SID",
    required: false,
    schema: z
      .string()
      .regex(/^AC[0-9a-fA-F]{32}$/, 'must start with "AC" followed by 32 hex digits'),
  },
  {
    key: "TWILIO_AUTH_TOKEN",
    required: false,
    schema: z.string().min(20, "looks like a placeholder"),
  },
  {
    key: "TWILIO_PHONE_NUMBER",
    required: false,
    schema: e164PhoneNumber,
  },
  {
    key: "SMS_MAX_ATTEMPTS",
    required: false,
    default: "5",
    schema: z
      .string()
      .regex(/^([1-9]|[12]\d|30)$/, "must be an integer between 1 and 30"),
  },
  {
    key: "CRON_SECRET",
    required: false,
    schema: z
      .string()
      .min(16, "must be at least 16 characters when configured"),
  },
  {
    key: "GEMINI_API_KEY",
    required: false,
    schema: z.string().trim().min(1, "must not be blank when configured"),
  },
  {
    key: "GEMINI_MODEL",
    required: false,
    default: "gemini-2.5-flash",
    schema: z.string().trim().min(1, "must not be blank when configured"),
  },
];

export const REQUIRED_ENV = ENV_SPECS.filter((spec) => spec.required).map(
  (spec) => spec.key
);

export const OPTIONAL_ENV = ENV_SPECS.filter((spec) => !spec.required).map(
  (spec) => spec.key
);

/**
 * Parses and validates a snapshot of the environment.
 *
 * An unset variable and an empty one are the same thing here, mirroring the
 * dashboard's contract in `appwrite.config.ts`: a `.env.local` written from
 * `.env.example` without editing the placeholders produces empty values, and
 * reporting those as configured would send an admin chasing the wrong problem.
 */
export const parseEnv = (
  source: Record<string, string | undefined>
): ParsedEnv => {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  const invalid: EnvProblem[] = [];

  for (const spec of ENV_SPECS) {
    const raw = source[spec.key];

    if (raw === undefined || raw === "") {
      if (spec.default !== undefined) {
        values[spec.key] = spec.default;
      } else if (spec.required) {
        missing.push(spec.key);
      }
      continue;
    }

    const result = spec.schema.safeParse(raw);

    if (result.success) {
      values[spec.key] = raw;
    } else {
      invalid.push({
        name: spec.key,
        value: raw,
        reason: result.error.issues[0]?.message ?? "is invalid",
      });
    }
  }

  return { values, missing, invalid };
};

/**
 * Startup gate, opt-in via `STRICT_ENV=true`.
 *
 * Throws an aggregate listing every problem at once, so an operator fixing a
 * deployment sees the whole list rather than one failure at a time. Only
 * required variables count as missing; absent optional ones (Sentry, Twilio)
 * are fine.
 */
export const validateEnv = () => {
  if (process.env.STRICT_ENV !== "true") return;

  const { missing, invalid } = parseEnv(process.env);

  const problems = [
    ...missing.map((name) => `missing ${name}`),
    ...invalid.map(
      (problem) =>
        `${problem.name} (set to "${problem.value}") is invalid: ${problem.reason}`
    ),
  ];

  if (problems.length > 0) {
    throw new Error(
      `Environment validation failed:\n- ${problems.join("\n- ")}\nSet the values correctly and try again.`
    );
  }
};

const ENV_DEFAULTS: Record<string, string> = {
  SENTRY_TELEMETRY: "false",
  SMS_MAX_ATTEMPTS: "5",
  GEMINI_MODEL: "gemini-2.5-flash",
};

/**
 * Read-through accessor. Each get reads the live `process.env`, so values are
 * never frozen at import time, and a missing variable reads as `""` — which
 * keeps an unset secret loudly failing in its original module rather than
 * being papered over with a default here.
 *
 * The accessor deliberately does not filter out invalid values: dropping them
 * would paper over a misconfigured value with "not set" and silently change
 * what every downstream module sees. Invalid values are surfaced by
 * `parseEnv` and `validateEnv` instead, where operators opt into enforcement.
 */
export const env = new Proxy({} as Record<string, string>, {
  get(_target, property) {
    if (typeof property !== "string") return undefined;

    const raw = process.env[property];

    if (raw !== undefined && raw !== "") return raw;

    return ENV_DEFAULTS[property] ?? "";
  },
});