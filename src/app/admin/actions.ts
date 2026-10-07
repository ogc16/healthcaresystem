"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import {
  ADMIN_SESSION_COOKIE,
  adminSessionMaxAge,
  constantTimeEqual,
  createSessionToken,
} from "@/lib/auth/session";
import { createThrottle, clientAddress } from "@/lib/auth/throttle";
import { env } from "@/lib/env";

const LOGIN_WINDOW_MS = 15 * 60 * 1000;

/**
 * The passkey is short enough that unlimited guessing is a real threat.
 *
 * Five attempts per address, plus a ceiling of fifty across all addresses. The
 * ceiling is the one that actually holds, because `x-forwarded-for` is
 * client-controlled on any deployment that is not behind a proxy that rewrites
 * it, so the per-address limit alone can be sidestepped by rotating the header.
 */
const signInAttempts = createThrottle({
  limit: 5,
  overallLimit: 50,
  windowMs: LOGIN_WINDOW_MS,
});

export const authenticateAdmin = async (formData: FormData) => {
  const passkey = String(formData.get("passkey") ?? "");
  const expectedPasskey = env.ADMIN_PASSKEY;

  // Returned, not thrown: an uncaught error in a server action tears down the
  // page to the global error boundary, which tells the user nothing about what
  // to do. It also leaked the variable name to the browser, confirming which
  // piece of deployment config is missing.
  if (!expectedPasskey) {
    return { error: "Admin sign-in is not configured on this server." };
  }

  const address = await clientAddress();
  const refused = await signInAttempts.check(address);

  if (refused) return { error: refused };

  // Compared only after the throttle, so a locked-out caller cannot use the
  // response timing to probe the passkey.
  if (!constantTimeEqual(passkey, expectedPasskey)) {
    return { error: "Invalid passkey. Please try again." };
  }

  // A success clears that address so a user who fumbles a few times is not
  // locked out for the rest of the window. The overall ceiling is deliberately
  // left alone: it is a volume guard, not a per-user budget.
  signInAttempts.reset(address);

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