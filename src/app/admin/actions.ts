"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import {
  ADMIN_SESSION_COOKIE,
  adminSessionMaxAge,
  constantTimeEqual,
  createAdminSessionToken,
} from "@/lib/auth/session";

export const authenticateAdmin = async (formData: FormData) => {
  const passkey = String(formData.get("passkey") ?? "");
  const expectedPasskey = process.env.ADMIN_PASSKEY ?? "";

  if (!expectedPasskey) throw new Error("ADMIN_PASSKEY is not set");

  if (!constantTimeEqual(passkey, expectedPasskey)) {
    return { error: "Invalid passkey. Please try again." };
  }

  const maxAge = adminSessionMaxAge();
  const expiresAt = Math.floor(Date.now() / 1000) + maxAge;
  const store = await cookies();

  store.set(ADMIN_SESSION_COOKIE, await createAdminSessionToken(expiresAt), {
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