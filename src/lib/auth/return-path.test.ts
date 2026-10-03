/**
 * Post-authentication redirect guard.
 *
 * `redirect()` honours absolute URLs, so an unvalidated `from` value would turn
 * post-login navigation into an open redirect. Both the login page and the
 * `loginPatient` action run `safeReturnPath`, so this is the only thing standing
 * between an attacker and a convincing phishing hop off the site.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_RETURN_PATH, safeReturnPath } from "./return-path";

const accepts = (value: string | string[], expected: string) => {
  expect(safeReturnPath(value)).toBe(expected);
};

const rejects = (value: unknown, label: string) => {
  expect(safeReturnPath(value as string | string[]), label).toBe(
    DEFAULT_RETURN_PATH
  );
};

describe("safeReturnPath preserves genuine patient destinations", () => {
  it("keeps a local patient path", () => {
    accepts("/patients/new-appointment", "/patients/new-appointment");
    accepts("/patients/register", "/patients/register");
  });

  it("keeps a query string", () => {
    accepts(
      "/patients/new-appointment/success?appointmentId=abc123",
      "/patients/new-appointment/success?appointmentId=abc123"
    );
  });

  it("uses the first value when handed an array", () => {
    accepts(["/patients/register", "/admin"], "/patients/register");
  });
});

describe("safeReturnPath rejects absolute URLs", () => {
  it("refuses scheme and protocol-relative forms", () => {
    rejects("https://evil.com", "https");
    rejects("http://evil.com", "http");
    rejects("//evil.com", "protocol-relative");
    rejects("///evil.com", "triple-slash");
  });

  it("refuses script-bearing schemes", () => {
    rejects("javascript:alert(1)", "javascript");
    rejects("data:text/html,<script>", "data");
  });
});

describe("safeReturnPath stays inside the patient portal", () => {
  it("refuses local paths outside /patients/", () => {
    rejects("/admin", "admin root");
    rejects("/admin/patients", "admin patients");
    rejects("/", "site root");
    rejects("/sentry-example-page", "sentry page");
  });

  it("refuses traversal that normalises out of the prefix", () => {
    rejects("/patients/../admin", "traversal to admin");
    rejects("/patients/../../etc", "deep traversal");
  });
});

describe("safeReturnPath refuses header and path separators", () => {
  it("refuses backslashes", () => {
    rejects("/patients\\@evil.com", "backslash");
  });

  it("refuses CRLF injection", () => {
    rejects("/patients/ok\r\nSet-Cookie: x=1", "CRLF");
    rejects("/patients/ok\nSet-Cookie: x=1", "LF");
  });
});

describe("safeReturnPath fails closed on non-strings", () => {
  it("refuses empty, nullish and non-string input", () => {
    rejects("", "empty string");
    rejects(undefined, "undefined");
    rejects(null, "null");
    rejects([], "empty array");
    rejects(42, "number");
    rejects({}, "object");
  });
});