import { afterEach, describe, expect, it } from "vitest";

import { missingAppwriteEnv } from "./appwrite.config";

const REQUIRED = [
  "NEXT_PUBLIC_ENDPOINT",
  "PROJECT_ID",
  "API_KEY",
  "DATABASE_ID",
  "PATIENT_COLLECTION_ID",
  "DOCTOR_COLLECTION_ID",
  "APPOINTMENT_COLLECTION_ID",
] as const;

const snapshot = new Map(REQUIRED.map((name) => [name, process.env[name]]));

const restore = () => {
  for (const [name, value] of snapshot) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
};

const clearAll = () => {
  for (const name of REQUIRED) delete process.env[name];
};

const setAll = () => {
  for (const name of REQUIRED) process.env[name] = `value-for-${name}`;
};

afterEach(restore);

describe("missingAppwriteEnv", () => {
  it("reports nothing when every required variable is set", () => {
    setAll();

    expect(missingAppwriteEnv()).toEqual([]);
  });

  it("reports every required variable when none are set", () => {
    clearAll();

    expect(missingAppwriteEnv()).toEqual([...REQUIRED]);
  });

  it("names only the variables that are absent", () => {
    setAll();
    delete process.env.DATABASE_ID;
    delete process.env.API_KEY;

    expect(missingAppwriteEnv()).toEqual(["API_KEY", "DATABASE_ID"]);
  });

  it("treats an empty string as missing", () => {
    setAll();
    process.env.PROJECT_ID = "";

    // A .env.local copied from .env.example without editing the placeholders
    // produces empty values, not absent ones. Reporting those as configured
    // would send the admin chasing the wrong problem.
    expect(missingAppwriteEnv()).toEqual(["PROJECT_ID"]);
  });

  it("reads process.env at call time rather than at import time", () => {
    setAll();
    expect(missingAppwriteEnv()).toEqual([]);

    delete process.env.PROJECT_ID;
    expect(missingAppwriteEnv()).toEqual(["PROJECT_ID"]);

    process.env.PROJECT_ID = "restored";
    expect(missingAppwriteEnv()).toEqual([]);
  });

  it("never names the storage bucket, which the dashboard does not use", () => {
    setAll();
    delete process.env.NEXT_PUBLIC_BUCKET_ID;

    expect(missingAppwriteEnv()).toEqual([]);
    expect(missingAppwriteEnv()).not.toContain("NEXT_PUBLIC_BUCKET_ID");
  });

  it("reports endpoint as missing alongside the rest", () => {
    clearAll();

    expect(missingAppwriteEnv()).toContain("NEXT_PUBLIC_ENDPOINT");
  });
});