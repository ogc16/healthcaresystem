import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import {
  ADMIN_SESSION_COOKIE,
  PATIENT_SESSION_COOKIE,
  type SessionRole,
  verifySessionToken,
} from "./session";

export type AppSession = {
  role: SessionRole;
  /** Appwrite user id. Present for patient sessions only. */
  userId?: string;
  /** Appwrite session id, used to revoke on logout. */
  appwriteSessionId?: string;
};

/**
 * Single source of truth for "who is calling". Server-only: it reads cookies
 * and may redirect, so it must never be imported by a client component.
 *
 * Middleware duplicates the signature check (it cannot import this module,
 * because it runs on the Edge runtime), so treat that copy as the outer shell
 * and this function as the authority that actions rely on.
 */
export const getSession = async (): Promise<AppSession | null> => {
  const store = await cookies();

  const patient = await verifySessionToken(
    store.get(PATIENT_SESSION_COOKIE)?.value
  );

  if (patient?.role === "patient" && patient.payload.uid) {
    return {
      role: "patient",
      userId: patient.payload.uid,
      appwriteSessionId: patient.payload.sid,
    };
  }

  const admin = await verifySessionToken(store.get(ADMIN_SESSION_COOKIE)?.value);

  if (admin?.role === "admin") return { role: "admin" };

  return null;
};

export const isAdminSession = async () =>
  (await getSession())?.role === "admin";

export const isPatientSession = async () =>
  (await getSession())?.role === "patient";

/**
 * For pages and actions that only patients may reach. Redirects rather than
 * throwing so callers do not each have to handle the failure case.
 */
export const requirePatient = async () => {
  const session = await getSession();

  if (session?.role !== "patient" || !session.userId) redirect("/login");

  return { userId: session.userId, appwriteSessionId: session.appwriteSessionId };
};

/**
 * Admin may act on any patient's records; a patient only on their own. Callers
 * that need to know *which* identity applies use this to avoid duplicating the
 * comparison that every ownership check needs.
 */
export const assertCanActForPatient = (session: AppSession, targetUserId: string) => {
  if (session.role === "admin") return;

  if (session.userId !== targetUserId) {
    throw new Error("Unauthorized: you do not have access to this record");
  }
};
