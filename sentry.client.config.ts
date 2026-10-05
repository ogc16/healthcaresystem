// This file configures the initialization of Sentry on the client.
// The config you add here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";

/**
 * Unset by default, which disables reporting entirely.
 *
 * This used to be a committed DSN pointing at the upstream tutorial author's
 * Sentry project, so every error and every sampled session replay from any
 * deployment of this app was reported to a third party they do not control. On
 * an application that handles patient data that is a disclosure nobody opted
 * into, and rotating the DSN alone would not have helped: the old one is in git
 * history from the first commit.
 *
 * `NEXT_PUBLIC_` is correct here and only here. A client-side DSN is public by
 * design — it is a write-only ingest key, not a credential — and this prefix is
 * what makes Next.js inline it into the browser bundle at build time. The server
 * DSN in sentry.server.config.ts must NOT use this prefix.
 */
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),

  // Adjust this value in production, or use tracesSampler for greater control
  tracesSampleRate: 1,

  // Setting this option to true will print useful information to the console while you're setting up Sentry.
  debug: false,

  replaysOnErrorSampleRate: 1.0,

  // This sets the sample rate to be 10%. You may want this to be 100% while
  // in development and sample at a lower rate in production
  replaysSessionSampleRate: 0.1,

  // You can remove this option if you're not planning to use the Sentry Session Replay feature:
  integrations: [
    Sentry.replayIntegration({
      // Additional Replay configuration goes in here, for example:
      maskAllText: true,
      blockAllMedia: true,
    }),
  ],
});
