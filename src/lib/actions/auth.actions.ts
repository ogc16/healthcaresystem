"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ID } from "node-appwrite";

import { account, users } from "../appwrite.config";
import { getSession } from "../auth/guards";
import { safeReturnPath } from "../auth/return-path";
import {
  createSessionToken,
  PATIENT_SESSION_COOKIE,
  patientSessionMaxAge,
} from "../auth/session";
import { parseStringify } from "../utils";
import { LoginSchema, PatientAccountSchema } from "../validation";

/**
 * Creates the Appwrite account for a new signup.
 *
 * Module-private: `patient.actions.ts` previously exported this, which made it
 * a network endpoint that skipped the schema validation below and returned the
 * full user record. Errors propagate on purpose — an earlier version caught 409
 * and returned the *existing* user, which is harmless only while users have no
 * password. With credentials it would hand an existing account's owner a
 * session for an account they created with someone else's email.
 */
const createUser = async (user: CreateUserParams) => {
  const newUser = await users.create(
    ID.unique(),
    user.email,
    user.phone,
    user.password,
    user.name
  );

  return parseStringify(newUser);
};

const cookieOptions = (maxAge: number) => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge,
});

/**
 * Appwrite is the authority on the credential; the cookie we hand out is a
 * signed assertion about the resulting session. Storing the Appwrite session id
 * lets logout revoke it upstream instead of only forgetting it locally.
 *
 * Credentials go through the keyless `account` client, so the verification
 * happens in Appwrite rather than being reimplemented here.
 */
const issuePatientSession = async (email: string, password: string) => {
  const session = await account.createEmailPasswordSession(email, password);
  const maxAge = patientSessionMaxAge();
  const store = await cookies();

  store.set(
    PATIENT_SESSION_COOKIE,
    await createSessionToken(
      "patient",
      { uid: session.userId, sid: session.$id },
      maxAge
    ),
    cookieOptions(maxAge)
  );
};

export const createPatientAccount = async (input: unknown) => {
  // Parsed here because this is a `"use server"` export: reachable directly over
  // the network, so the client's form validation is not a trust boundary.
  const parsed = PatientAccountSchema.safeParse(input);

  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? "Please check your details.",
    };
  }

  const values = parsed.data;

  try {
    await createUser(values);
  } catch (error: unknown) {
    if (isAppwriteError(error, 409)) {
      // Do not fall through to signing in: an existing account owns that email,
      // and silently continuing would hand its owner our password.
      return {
        error:
          "An account already exists for that email. Please sign in instead.",
      };
    }

    throw error;
  }

  await issuePatientSession(values.email, values.password);

  redirect("/patients/register");
};

export const loginPatient = async (input: unknown, returnTo?: string) => {
  // Parsed at the server boundary for the same reason as `createPatientAccount`.
  const parsed = LoginSchema.safeParse(input);

  if (!parsed.success) {
    return { error: "Enter your email and password." };
  }

  try {
    await issuePatientSession(parsed.data.email, parsed.data.password);
  } catch (error: unknown) {
    // 401 covers both an unknown email and a wrong password. Keeping them
    // indistinguishable stops this endpoint confirming which emails are registered.
    if (isAppwriteError(error, 401)) {
      return { error: "Invalid email or password." };
    }

    console.error("An error occurred while signing in:", error);

    return { error: "Unable to sign in right now. Please try again." };
  }

  redirect(safeReturnPath(returnTo));
};

export const logoutPatient = async () => {
  const session = await getSession();
  const store = await cookies();

  if (session?.role === "patient" && session.appwriteSessionId && session.userId) {
    try {
      await users.deleteSession(session.userId, session.appwriteSessionId);
    } catch (error) {
      // The cookie is cleared either way; a failure upstream only means the
      // Appwrite session lingers until it expires.
      console.error("Failed to revoke the Appwrite session:", error);
    }
  }

  store.delete(PATIENT_SESSION_COOKIE);
};

function isAppwriteError(error: unknown, code: number) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: number }).code === code
  );
}
