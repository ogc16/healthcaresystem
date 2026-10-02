import * as sdk from "node-appwrite";

export const {
  NEXT_PUBLIC_ENDPOINT: ENDPOINT,
  PROJECT_ID,
  API_KEY,
  DATABASE_ID,
  PATIENT_COLLECTION_ID,
  DOCTOR_COLLECTION_ID,
  APPOINTMENT_COLLECTION_ID,
  NEXT_PUBLIC_BUCKET_ID: BUCKET_ID,
} = process.env;

const client = new sdk.Client();

client.setEndpoint(ENDPOINT!).setProject(PROJECT_ID!).setKey(API_KEY!);

export const databases = new sdk.Databases(client);
export const users = new sdk.Users(client);
export const messaging = new sdk.Messaging(client);
export const storage = new sdk.Storage(client);

/**
 * Deliberately a separate client with no API key.
 *
 * `account.createEmailPasswordSession` is the public sign-in endpoint, so
 * attaching the admin key would make every lookup an admin lookup. Keeping it
 * keyless means Appwrite — not this app — is what decides whether the supplied
 * email and password are correct.
 *
 * Note the trap this avoids: `users.createSession(userId)` mints a valid
 * session for any user straight from the API key, with no password check at
 * all. It is a server-side impersonation helper, not a sign-in path.
 */
const accountClient = new sdk.Client();

accountClient.setEndpoint(ENDPOINT!).setProject(PROJECT_ID!);

export const account = new sdk.Account(accountClient);
