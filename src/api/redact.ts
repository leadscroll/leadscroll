/**
 * Path redaction shared by request logging and tracing. Query strings are
 * never part of these helpers, and public intake tokens are replaced before a
 * path can reach any sink.
 */

// Browser intake tokens travel in the pathname. They are intentionally public
// and write-only, but no sink may carry the token; this also keeps an API
// token pasted into the wrong URL out of the logs.
const PUBLIC_INTAKE_TOKEN_PATH = /^\/v1\/public\/intakes\/.+$/u;

export const redactPath = (pathname: string): string =>
  PUBLIC_INTAKE_TOKEN_PATH.test(pathname)
    ? '/v1/public/intakes/:token'
    : pathname;
