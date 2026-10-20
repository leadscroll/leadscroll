/**
 * Shared HTTP response helpers that are not part of the typed API contract.
 */

export const errorResponse = (
  status: number,
  code: string,
  message: string,
  details?: unknown,
): Response =>
  Response.json(
    { code, details, message },
    {
      status,
    },
  );

// The public intake route is unauthenticated and cookie-free, so it answers
// with `*` and no credentials. Scoped to the intake routes rather than through
// global middleware, which would add reflected, credentialed CORS headers to
// staff routes as well.
export const PUBLIC_CORS_HEADERS = {
  'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Max-Age': '86400',
} as const;
