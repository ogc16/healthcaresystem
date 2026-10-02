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

/**
 * Fails loudly, and by name.
 *
 * The previous version built both clients at module scope behind `!`
 * assertions. That let a missing variable reach the SDK as `undefined`, where
 * it surfaced as an opaque "Endpoint must be a valid string" from inside
 * node-appwrite during `next build`, with nothing pointing at the actual cause.
 * Worse, an unset `API_KEY` would have produced a client with no key attached,
 * turning privileged calls into anonymous ones instead of failing.
 *
 * Construction is therefore deferred to first use and the missing name is
 * reported directly.
 */
function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. See .env.example.`
    );
  }

  return value;
}

let client: sdk.Client | undefined;

/** Admin client. Carries the API key, so every call is a privileged one. */
function getClient(): sdk.Client {
  if (!client) {
    client = new sdk.Client();

    client
      .setEndpoint(requireEnv("NEXT_PUBLIC_ENDPOINT", ENDPOINT))
      .setProject(requireEnv("PROJECT_ID", PROJECT_ID))
      .setKey(requireEnv("API_KEY", API_KEY));
  }

  return client;
}

let accountClient: sdk.Client | undefined;

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
function getAccountClient(): sdk.Client {
  if (!accountClient) {
    accountClient = new sdk.Client();

    // No .setKey() here, by design. See above.
    accountClient
      .setEndpoint(requireEnv("NEXT_PUBLIC_ENDPOINT", ENDPOINT))
      .setProject(requireEnv("PROJECT_ID", PROJECT_ID));
  }

  return accountClient;
}

export const getDatabases = (): sdk.Databases =>
  new sdk.Databases(getClient());

export const getUsers = (): sdk.Users => new sdk.Users(getClient());

export const getMessaging = (): sdk.Messaging => new sdk.Messaging(getClient());

export const getStorage = (): sdk.Storage => new sdk.Storage(getClient());

export const getAccount = (): sdk.Account => new sdk.Account(getAccountClient());
