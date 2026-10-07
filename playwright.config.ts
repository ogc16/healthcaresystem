import { defineConfig, devices } from "@playwright/test";

const APP_PORT = 3100;
const MOCK_PORT = 7800;

const APP_URL = `http://localhost:${APP_PORT}`;
const MOCK_URL = `http://localhost:${MOCK_PORT}/v1`;

// Everything the app needs to run against the mock, rather than a real
// Appwrite project. STRICT_ENV is on so the suite also exercises the startup
// env validation that CI and unconfigured machines normally skip.
const appEnv = {
  NEXT_PUBLIC_ENDPOINT: MOCK_URL,
  PROJECT_ID: "test-project",
  API_KEY: "test-api-key-0123456789abcdef0123456789abcdef",
  DATABASE_ID: "test-database",
  PATIENT_COLLECTION_ID: "test-patients",
  DOCTOR_COLLECTION_ID: "test-doctors",
  APPOINTMENT_COLLECTION_ID: "test-appointments",
  AUDIT_COLLECTION_ID: "test-audit",
  SMS_OUTBOX_COLLECTION_ID: "test-sms-outbox",
  NEXT_PUBLIC_BUCKET_ID: "test-bucket",
  PHI_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  ADMIN_PASSKEY: "123456",
  SESSION_SECRET: "e2e-session-secret-0123456789abcdef0123456",
  CRON_SECRET: "e2e-cron-secret-0123456789",
  SENTRY_TELEMETRY: "false",
  STRICT_ENV: "true",
};

// Use the desktop's installed Chrome locally so no browser download is needed;
// CI installs Chromium explicitly in its job.
const browserOptions = process.env.CI
  ? devices["Desktop Chrome"]
  : { ...devices["Desktop Chrome"], channel: "chrome" };

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: APP_URL,
    ...browserOptions,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "node e2e/mock-appwrite.mjs",
      url: `${MOCK_URL}/__health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: `npm run dev -- -p ${APP_PORT}`,
      url: APP_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: appEnv,
    },
  ],
});