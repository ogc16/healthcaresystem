const DEFAULT_RETURN_PATH = "/patients/new-appointment";

/**
 * Validates a post-authentication redirect target.
 *
 * Both the login page and the `loginPatient` action run this. The input is
 * attacker-controllable (it comes from the `from` query parameter the
 * middleware appends, or straight from the client), and `redirect()` accepts
 * absolute URLs, so accepting an unchecked value would turn post-login
 * navigation into an open redirect.
 *
 * Rules:
 * - must start with a single "/" so "//evil.com" and "https://evil.com" are
 *   rejected rather than read as absolute URLs by the browser
 * - must be under "/patients/" so it cannot bounce a patient to /admin or an
 *   unrelated route after they authenticate
 * - must not contain a newline or backslash, which some parsers treat as a
 *   header or path separator
 * - must not contain a ".." segment: "/patients/../admin" passes a prefix test
 *   but normalises back to "/admin" before the browser requests it, so the
 *   prefix check alone would not hold
 * - anything else falls back to the default
 */
export const safeReturnPath = (value?: string | string[] | null) => {
  const candidate = Array.isArray(value) ? value[0] : value;

  if (typeof candidate !== "string") return DEFAULT_RETURN_PATH;
  if (candidate.length === 0) return DEFAULT_RETURN_PATH;
  if (candidate.includes("\\") || /[\r\n]/.test(candidate)) {
    return DEFAULT_RETURN_PATH;
  }
  if (!candidate.startsWith("/")) return DEFAULT_RETURN_PATH;
  if (candidate.startsWith("//")) return DEFAULT_RETURN_PATH;
  if (!candidate.startsWith("/patients/")) return DEFAULT_RETURN_PATH;
  if (candidate.split("/").includes("..")) return DEFAULT_RETURN_PATH;

  return candidate;
};

export { DEFAULT_RETURN_PATH };
