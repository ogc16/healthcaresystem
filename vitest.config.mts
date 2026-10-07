import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Mirrors the `@/*` path mapping in tsconfig.json. Declared here as well so
    // tests can import app modules by the same specifier the source uses.
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      // Test files and the app's HTTP entry points are outside the unit
      // metric: route handlers and server actions under src/app are exercised
      // by the Playwright suite against the mock Appwrite server instead.
      exclude: ["src/**/*.test.ts", "src/app/**"],
      // Deliberately a floor, not a target: CI fails when coverage drops
      // below what the suite already achieves, which forces new work to come
      // with unit tests instead of pushing the percentages down. The numbers
      // are the measured baseline as of the AI triage slice; the gap between
      // them and 100% is the code that needs integration-style coverage next.
      thresholds: {
        statements: 53,
        branches: 53,
        functions: 52,
        lines: 52,
      },
    },
  },
});