"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { createRateLimiter } from "@/lib/auth/rate-limit";
import {
  ADMIN_SESSION_COOKIE,
  adminSessionMaxAge,
  constantTimeEqual,
  createSessionToken,
} from "@/lib/auth/session";

const LOGIN_WINDOW_MS = 15 * 60 * 1000;

/**
 * The passkey is short enough that unlimited guessing is a real threat, so
 * attempts are throttled twice.
 *
 * Per address is the useful limit, but `x-forwarded-for` is client-controlled
 * on any deployment that is not behind a proxy that rewrites it, so a second
 * ceiling that keys on nothing an attacker can vary is what actually bounds
 * total guessing. Order matters: the per-address limiter is consumed first, so
 * a caller that is already locked out cannot burn the global budget and lock
 * everyone else out.
 */
const attemptsPerAddress = createRateLimiter({
  limit: 5,
  windowMs: LOGIN_WINDOW_MS,
});

const attemptsOverall = createRateLimiter({
  limit: 50,
  windowMs: LOGIN_WINDOW_MS,
});

const clientAddress = async () => {
  const store = await headers();

  // Leftmost entry is the originating client when the platform appends to the
  // header. The constant fallback keeps header-less callers in one shared
  // bucket rather than granting each of them a fresh allowance.
  return (
    store.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    store.get("x-real-ip") ||
    "unknown"
  );
};

const lockedOutMessage = (retryAfterSeconds: number) =>
  `Too many attempts. Try again in ${Math.max(1, Math.ceil(retryAfterSeconds / 60))} minute(s).`;

export const authenticateAdmin = async (formData: FormData) => {
  const passkey = String(formData.get("passkey") ?? "");
  const expectedPasskey = process.env.ADMIN_PASSKEY ?? "";

  // Returned, not thrown: an uncaught error in a server action tears down the
  // page to the global error boundary, which tells the user nothing about what
  // to do. It also leaked the variable name to the browser, confirming which
  // piece of deployment config is missing.
  if (!expectedPasskey) {
    return { error: "Admin sign-in is not configured on this server." };
  }

  const address = await clientAddress();
  const perAddress = attemptsPerAddress.consume(address);

  if (!perAddress.allowed) {
    return { error: lockedOutMessage(perAddress.retryAfterSeconds) };
  }

  const overall = attemptsOverall.consume("all");

  if (!overall.allowed) {
    return { error: lockedOutMessage(overall.retryAfterSeconds) };
  }

  // Compared only after the throttles, so a locked-out caller cannot use the
  // response timing to probe the passkey.
  if (!constantTimeEqual(passkey, expectedPasskey)) {
    return { error: "Invalid passkey. Please try again." };
  }

  // A success clears that address so a user who fumbles a few times is not
  // locked out for the rest of the window. The overall ceiling is deliberately
  // left alone: it is a volume guard, not a per-user budget.
  attemptsPerAddress.reset(address);

  const maxAge = adminSessionMaxAge();
  const store = await cookies();

  store.set(ADMIN_SESSION_COOKIE, await createSessionToken("admin", {}, maxAge), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge,
  });

  redirect("/admin");
};

export const signOutAdmin = async () => {
  const store = await cookies();

  store.delete(ADMIN_SESSION_COOKIE);

  redirect("/admin/login");
};