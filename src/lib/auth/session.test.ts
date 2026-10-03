/**
 * The session token contract. `src/proxy.ts`, the page guards and every mutating
 * server action trust whatever `verifySessionToken` returns, so these tests
 * assert the rejection paths as much as the happy path.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_SESSION_COOKIE,
  constantTimeEqual,
  createSessionToken,
  isValidAdminSessionToken,
  isValidPatientSessionToken,
  PATIENT_SESSION_COOKIE,
  patientSessionMaxAge,
  verifySessionToken,
} from "./session";

const SECRET = "test-secret-value-for-session-token-checks";

beforeEach(() => {
  process.env.SESSION_SECRET = SECRET;
});

const encoder = new TextEncoder();

const toBase64Url = (bytes: Uint8Array) => {
  let binary = "";

  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/**
 * Signs an arbitrary `<role>.<body>` pair the way `session.ts` does.
 *
 * The rejection tests below present tokens that are signed *correctly* but whose
 * payload is malformed. Signing them any other way would let the signature check
 * refuse them first, so the test would pass without ever reaching the payload
 * validation it claims to cover.
 */
const signAsSessionDoes = async (role: string, body: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  return toBase64Url(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, encoder.encode(`${role}.${body}`))
    )
  );
};

const patientToken = () =>
  createSessionToken("patient", { uid: "user-1", sid: "session-1" });

const adminToken = () => createSessionToken("admin", {});

describe("session token round-trip", () => {
  it("carries the admin role and no subject claims", async () => {
    const verified = await verifySessionToken(await adminToken());

    expect(verified?.role).toBe("admin");
    expect(verified?.payload.uid).toBeUndefined();
    expect(verified?.payload.sid).toBeUndefined();
  });

  it("preserves the patient uid and sid", async () => {
    const verified = await verifySessionToken(await patientToken());

    expect(verified?.role).toBe("patient");
    expect(verified?.payload.uid).toBe("user-1");
    expect(verified?.payload.sid).toBe("session-1");
  });
});

describe("session token tampering", () => {
  it("rejects a mutated payload", async () => {
    const [, body, signature] = (await patientToken()).split(".");

    expect(
      await verifySessionToken(`patient.${body}x.${signature}`)
    ).toBeNull();
  });

  it("rejects a mutated signature", async () => {
    const [, body, signature] = (await patientToken()).split(".");

    expect(
      await verifySessionToken(`patient.${body}.${signature}x`)
    ).toBeNull();
  });

  it("rejects a single flipped signature character", async () => {
    const [, body, signature] = (await patientToken()).split(".");
    const flipped = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;

    expect(
      await verifySessionToken(`patient.${body}.${flipped}`)
    ).toBeNull();
  });

  it("refuses a patient token replayed as admin", async () => {
    const [, body, signature] = (await patientToken()).split(".");

    expect(await verifySessionToken(`admin.${body}.${signature}`)).toBeNull();
  });

  it("refuses an admin token replayed as patient", async () => {
    const [, body, signature] = (await adminToken()).split(".");

    expect(await verifySessionToken(`patient.${body}.${signature}`)).toBeNull();
  });

  it("refuses a correctly signed unknown role", async () => {
    const body = toBase64Url(
      encoder.encode(
        JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })
      )
    );
    const signature = await signAsSessionDoes("superadmin", body);

    expect(await verifySessionToken(`superadmin.${body}.${signature}`)).toBeNull();
  });

  it("refuses a token signed under a different secret", async () => {
    const [, body, signature] = (await patientToken()).split(".");

    process.env.SESSION_SECRET = "a-completely-different-secret";

    expect(
      await verifySessionToken(`patient.${body}.${signature}`)
    ).toBeNull();
  });
});

describe("session token structure", () => {
  it("rejects an expired token", async () => {
    const expired = await createSessionToken(
      "patient",
      { uid: "u", sid: "s" },
      -1
    );

    expect(await verifySessionToken(expired)).toBeNull();
  });

  it("refuses a zero TTL to mint a live session", async () => {
    const token = await createSessionToken("patient", { uid: "u", sid: "s" }, 0);

    expect(await verifySessionToken(token)).toBeNull();
  });

  it("rejects tokens with missing segments", async () => {
    for (const bad of [
      "",
      "patient",
      "patient.body",
      ".body.sig",
      "patient..sig",
    ]) {
      expect(await verifySessionToken(bad), bad).toBeNull();
    }
  });

  it("rejects null and undefined", async () => {
    expect(await verifySessionToken(null)).toBeNull();
    expect(await verifySessionToken(undefined)).toBeNull();
  });

  it("rejects a correctly signed token whose exp is not a number", async () => {
    const body = toBase64Url(encoder.encode(JSON.stringify({ exp: "soon" })));
    const signature = await signAsSessionDoes("admin", body);

    expect(await verifySessionToken(`admin.${body}.${signature}`)).toBeNull();
  });

  it("rejects a correctly signed patient token with no subject", async () => {
    // A patient token that authorises nobody while still looking valid would be
    // worse than no token at all, so it is treated as malformed.
    const body = toBase64Url(
      encoder.encode(
        JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })
      )
    );
    const signature = await signAsSessionDoes("patient", body);

    expect(await verifySessionToken(`patient.${body}.${signature}`)).toBeNull();
  });
});

describe("role helpers", () => {
  it("agree with verifySessionToken", async () => {
    expect(await isValidAdminSessionToken(await adminToken())).toBe(true);
    expect(await isValidPatientSessionToken(await patientToken())).toBe(true);
  });

  it("will not let a patient token satisfy the admin check", async () => {
    expect(await isValidAdminSessionToken(await patientToken())).toBe(false);
  });

  it("will not let an admin token satisfy the patient check", async () => {
    expect(await isValidPatientSessionToken(await adminToken())).toBe(false);
  });
});

describe("constantTimeEqual", () => {
  it("matches identical strings", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("", "")).toBe(true);
  });

  it("separates different strings and lengths", () => {
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "x")).toBe(false);
  });
});

describe("session lifetime", () => {
  it("is positive and does not outlive a day", () => {
    const maxAge = patientSessionMaxAge();

    expect(typeof maxAge).toBe("number");
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(60 * 60 * 24);
  });
});

describe("cookie names", () => {
  it("are distinct so the two sessions cannot collide", () => {
    expect(ADMIN_SESSION_COOKIE).toBe("hcs_admin_session");
    expect(PATIENT_SESSION_COOKIE).toBe("hcs_patient_session");
    expect(ADMIN_SESSION_COOKIE).not.toBe(PATIENT_SESSION_COOKIE);
  });
});