import { validateEnv } from "@/lib/env";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Opt-in (STRICT_ENV=true) so CI and unconfigured dev machines still boot,
    // while a production deployment can fail at startup instead of at the
    // first request that hits a bad value.
    validateEnv();
    await import("../sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }
}
