// @sentry/nextjs v11 re-exports withSentryConfig from a dedicated "./config"
// subpath. The root entry stays CJS for the Next.js server bundle, so importing
// it here fails under Node's ESM loader with "Named export 'withSentryConfig'
// not found". Import the build-time entry directly instead.
import { withSentryConfig } from "@sentry/nextjs/config";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Turbopack walks up looking for a lockfile to infer the project root. This
  // repo is nested under the user profile, which has its own package-lock.json,
  // so Turbopack warned on every `next dev` / `next build` that it was ignoring
  // C:\Users\user\package-lock.json. Pinning the root keeps resolution and file
  // watching anchored to the repo regardless of where it is checked out.
  turbopack: {
    root: process.cwd(),
  },
  experimental: {
    // Registration uploads an identification document through a server action,
    // so the request body carries the file. This defaults to 1mb, which
    // silently rejects most scans with an opaque error.
    //
    // 4mb is deliberate and is the ceiling that matters here: Vercel rejects
    // request bodies over 4.5mb (Node) / 4mb (Edge) before this value is ever
    // consulted. MAX_UPLOAD_BYTES in src/lib/uploads.ts sits below it so the
    // user gets a validation message instead of a 413.
    serverActions: {
      bodySizeLimit: "4mb",
    },
  },
};

export default withSentryConfig(nextConfig, {
  // For all available options, see:
  // https://github.com/getsentry/sentry-webpack-plugin#options

  org: process.env.SENTRY_ORG ?? "carepulse",
  project: process.env.SENTRY_PROJECT ?? "care-pulse",

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI,

  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  // Uncomment to route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
  // This can increase your server load as well as your hosting bill.
  // Note: Check that the configured route will not match with your Next.js middleware, otherwise reporting of client-
  // side errors will fail.
  // tunnelRoute: "/monitoring",

  // Hides source maps from generated client bundles
  hideSourceMaps: true,

  // Automatically tree-shake Sentry logger statements to reduce bundle size
  disableLogger: true,

  // Enables automatic instrumentation of Vercel Cron Monitors. (Does not yet work with App Router route handlers.)
  // See the following for more information:
  // https://docs.sentry.io/product/crons/
  // https://vercel.com/docs/cron-jobs
  automaticVercelMonitors: true,
});
