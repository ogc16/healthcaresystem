import { env } from "@/lib/env";

const encoder = new TextEncoder();

const SESSION_TTL_SECONDS = 60 * 60 * 8;

export const ADMIN_SESSION_COOKIE = "hcs_admin_session";
export const PATIENT_SESSION_COOKIE = "hcs_patient_session";

export type SessionRole = "admin" | "patient";

export type SessionPayload = {
  /** Unix seconds. */
  exp: number;
  /** Appwrite user id. Present for patient sessions only. */
  uid?: string;
  /** Appwrite session id, so logout can revoke it rather than just drop the cookie. */
  sid?: string;
};

export const adminSessionMaxAge = () => SESSION_TTL_SECONDS;
export const patientSessionMaxAge = () => SESSION_TTL_SECONDS;

const toBase64Url = (bytes: Uint8Array) => {
  let binary = "";

  for (let index = 0; index < bytes.length; index++) {
    binary += String.fromCharCode(bytes[index]);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const fromBase64Url = (value: string) => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
};

export const constantTimeEqual = (left: string, right: string) => {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.max(a.length, b.length);

  let diff = a.length ^ b.length;

  for (let index = 0; index < length; index++) {
    diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }

  return diff === 0;
};

const getSessionSecret = () => {
  const secret = env.SESSION_SECRET;

  if (!secret) throw new Error("SESSION_SECRET is not set");

  return secret;
};

const sign = async (value: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(getSessionSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  return toBase64Url(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)))
  );
};

/**
 * Token shape is `<role>.<base64url(payload)>.<hmac>`.
 *
 * The payload is JSON rather than dot-joined fields because Appwrite ids may
 * themselves contain characters that would break a positional split. The
 * signature covers the role as well as the payload, so a patient token cannot
 * be replayed as an admin token even though both share SESSION_SECRET.
 */
export const createSessionToken = async (
  role: SessionRole,
  claims: Omit<SessionPayload, "exp">,
  maxAgeSeconds: number = SESSION_TTL_SECONDS
) => {
  const payload: SessionPayload = {
    ...claims,
    exp: Math.floor(Date.now() / 1000) + maxAgeSeconds,
  };

  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await sign(`${role}.${body}`);

  return `${role}.${body}.${signature}`;
};

export type VerifiedSession = {
  role: SessionRole;
  payload: SessionPayload;
};

/**
 * Verifies signature before parsing, and returns null on any failure. A caller
 * that gets a non-null result may trust both the role and the payload.
 */
export const verifySessionToken = async (
  token?: string | null
): Promise<VerifiedSession | null> => {
  if (!token) return null;

  const parts = token.split(".");

  if (parts.length !== 3) return null;

  const [role, body, signature] = parts;

  if (role !== "admin" && role !== "patient") return null;
  if (!body || !signature) return null;

  if (!constantTimeEqual(signature, await sign(`${role}.${body}`))) return null;

  let payload: SessionPayload;

  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64Url(body)));
  } catch {
    return null;
  }

  if (typeof payload?.exp !== "number" || !Number.isFinite(payload.exp)) return null;
  if (payload.exp * 1000 <= Date.now()) return null;

  // A patient token without a subject would authorise nobody while still
  // looking valid, so treat it as malformed rather than authentic.
  if (role === "patient" && (!payload.uid || !payload.sid)) return null;

  return { role, payload };
};

const hasRole = async (token: string | undefined | null, role: SessionRole) => {
  const session = await verifySessionToken(token);

  return session?.role === role;
};

export const isValidAdminSessionToken = (token?: string | null) =>
  hasRole(token, "admin");

export const isValidPatientSessionToken = (token?: string | null) =>
  hasRole(token, "patient");
