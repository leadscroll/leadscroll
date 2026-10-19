import {
  type Auth,
  AuthConfigurationError,
  authenticationNotConfiguredResponse,
} from '@/auth';
import { createAccountAuthEndpoints } from '@/auth/account-management';
import { handleInvitationSignUp } from '@/auth/invitation-sign-up';
import {
  blockedRetryAfter,
  rateLimitedResponse,
  rememberBlocked,
} from '@/auth/rate-limit-cache';
import { handleDisabledAccountSignIn } from '@/auth/sign-in-guard';
import { type Env } from '@/db/repository';

export const createAuthHandler = (
  environment: Env,
  getAuth: (request: Request) => Auth,
): ((request: Request) => Promise<Response>) => {
  const accountAuthEndpoints = createAccountAuthEndpoints(getAuth, environment);

  return async (request) => {
    try {
      const url = new URL(request.url);
      const mountedPath = url.pathname.slice('/api/auth'.length) || '/';
      const accountPath = mountedPath.replace(/\/+$/u, '');
      // Normalize only account endpoints so their field/revocation boundary
      // covers trailing slashes. Preserve existing sign-up alias rejection.
      const path =
        accountPath === '/update-user' || accountPath === '/change-password'
          ? accountPath
          : mountedPath;
      url.pathname = path;
      const normalized = new Request(url, request);

      // A client already over a limit skips Better Auth (and the database
      // limiter's read/update) until its retry window passes. The database
      // counter stays authoritative; this only short-circuits known blocks.
      const retryAfter = await blockedRetryAfter(normalized, path);
      if (retryAfter !== null) {
        return rateLimitedResponse(retryAfter);
      }

      const dispatch = async (): Promise<Response> => {
        if (normalized.method === 'POST' && path === '/sign-up/email') {
          return handleInvitationSignUp(environment, normalized, getAuth);
        }

        if (normalized.method === 'POST' && path === '/sign-in/email') {
          return handleDisabledAccountSignIn(environment, normalized, getAuth);
        }

        // Self-service account management: the interceptors validate and
        // re-attach the body before Better Auth runs.
        if (normalized.method === 'POST' && path === '/change-password') {
          const raw = await normalized.text();
          return accountAuthEndpoints.changePassword(normalized, raw);
        }

        if (normalized.method === 'POST' && path === '/update-user') {
          const raw = await normalized.text();
          return accountAuthEndpoints.updateUser(normalized, raw);
        }

        const authUrl = new URL(normalized.url);
        authUrl.pathname = `/api/auth${path}`;
        return getAuth(normalized).handler(new Request(authUrl, normalized));
      };

      const response = await dispatch();
      if (response.status === 429) {
        await rememberBlocked(
          normalized,
          path,
          Number(response.headers.get('x-retry-after') ?? ''),
        );
      }

      return response;
    } catch (error) {
      if (error instanceof AuthConfigurationError) {
        return authenticationNotConfiguredResponse();
      }

      throw error;
    }
  };
};
