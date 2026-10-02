const encoder = new TextEncoder();

const SESSION_TTL_SECONDS = 60 * 60 * 8;

export const ADMIN_SESSION_COOKIE = "hcs_admin_session";

export const adminSessionMaxAge = () => SESSION_TTL_SECONDS;

const base64UrlEncode = (bytes: ArrayBuffer) => {
  const view = new Uint8Array(bytes);

  let binary = "";

  for (let index = 0; index < view.length; index++) {
    binary += String.fromCharCode(view[index]);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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
  const secret = process.env.SESSION_SECRET;

  if (!secret) throw new Error("SESSION_SECRET is not set");

  return secret;
};

const signPayload = async (payload: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(getSessionSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  return base64UrlEncode(
    await crypto.subtle.sign("HMAC", key, encoder.encode(payload))
  );
};

export const createAdminSessionToken = async (expiresAt: number) =>
  `admin.${expiresAt}.${await signPayload(`admin.${expiresAt}`)}`;

export const isValidAdminSessionToken = async (token?: string | null) => {
  if (!token) return false;

  const [role, expiresAt, signature] = token.split(".");

  if (role !== "admin" || !expiresAt || !signature) return false;

  const expiry = Number(expiresAt);

  if (!Number.isFinite(expiry) || expiry * 1000 <= Date.now()) return false;

  return constantTimeEqual(signature, await signPayload(`admin.${expiresAt}`));
};