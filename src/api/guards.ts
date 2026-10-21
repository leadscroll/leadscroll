import { errorResponse } from './http';
import { logRequest } from './logging';
import {
  type Auth,
  AuthConfigurationError,
  authenticationNotConfiguredResponse,
  resolveAuthOrigin,
} from '@/auth';
import {
  requireSessionIdentity,
  type SessionIdentity,
  UnauthorizedError,
} from '@/auth/access';
import { type Env } from '@/db/env';

export type AuthForRequest = (request: Request) => Auth;

/**
 * Browser CSRF defence: a request that carries an Origin header must match the
 * configured auth origin. A missing Origin is allowed for non-browser clients,
 * consistent with the auth routes. Forwarded headers are never consulted.
 */
export const rejectUntrustedOrigin = (
  environment: Env,
  request: Request,
): null | Response => {
  const origin = request.headers.get('Origin');
  if (origin === null) {
    return null;
  }

  let trusted: string;
  try {
    trusted = resolveAuthOrigin(environment, request);
  } catch (error) {
    if (error instanceof AuthConfigurationError) {
      return authenticationNotConfiguredResponse();
    }

    throw error;
  }

  return origin === trusted
    ? null
    : errorResponse(403, 'forbidden', 'The request origin is not trusted.');
};

const UNSAFE_METHODS = new Set(['DELETE', 'PATCH', 'POST', 'PUT']);

/**
 * Cookie-authenticated staff routes set no CORS headers, so a hostile page
 * cannot read their responses; but a same-site sibling origin can still post an
 * ordinary HTML form and have the browser attach the session cookie under
 * SameSite=Lax. Unsafe methods therefore require a trusted Origin when one is
 * present, and any supplied body must be JSON; the boundary never parses
 * form-encoded posts on these routes.
 */
export const rejectUntrustedStaffWrite = (
  environment: Env,
  request: Request,
): null | Response => {
  if (!UNSAFE_METHODS.has(request.method)) {
    return null;
  }

  const rejectedOrigin = rejectUntrustedOrigin(environment, request);
  if (rejectedOrigin !== null) {
    return rejectedOrigin;
  }

  const contentType = request.headers.get('content-type');
  if (contentType !== null) {
    // The media type is everything before any parameters (`; charset=...`).
    // Only exact `application/json` is accepted: a prefix check would let
    // `application/jsonp` and similar types through.
    const mediaType = contentType.split(';')[0]?.trim().toLowerCase();
    if (mediaType !== 'application/json') {
      return errorResponse(
        415,
        'unsupported_media_type',
        'Staff requests with a body must use application/json.',
      );
    }
  }

  return null;
};

export const requireAdmin = async (
  request: Request,
  getAuth: AuthForRequest,
  environment: Env,
) => {
  try {
    return {
      identity: await requireSessionIdentity(
        request,
        getAuth(request),
        environment,
      ),
    } as const;
  } catch (error) {
    if (error instanceof AuthConfigurationError) {
      return { error: authenticationNotConfiguredResponse() } as const;
    }

    if (error instanceof UnauthorizedError) {
      return {
        error: errorResponse(401, 'unauthorized', error.message),
      } as const;
    }

    // The identity lookup itself failed (for example a D1 fault while
    // reading the session or staff row): this is an authentication backend
    // failure, not a lost login. Report a generic 500 so the client can
    // retry, and log the cause's class so it can be told
    // apart from a true 401 in the logs. The exception message is never
    // logged or returned because it can embed SQL with bound values.
    logRequest(request, 500, {
      errorCauseClass:
        error instanceof Error ? error.constructor.name : typeof error,
      errorClass: 'AuthenticationUnavailable',
    });
    return {
      error: errorResponse(
        500,
        'authentication_unavailable',
        'Authentication could not be checked. Please try again.',
      ),
    } as const;
  }
};

export type ResolveStaff = (
  request: Request,
) => Promise<StaffContext | { error: Response }>;

export type StaffContext = {
  adminEmail: string;
  adminSession: SessionIdentity['session'];
  adminUserId: null | string;
};
