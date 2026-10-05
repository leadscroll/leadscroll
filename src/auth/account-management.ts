import {
  type Auth,
  AuthConfigurationError,
  authenticationNotConfiguredResponse,
} from '@/auth';
import { requireSessionIdentity, UnauthorizedError } from '@/auth/access';
import { type Env } from '@/db/repository';
import {
  ChangeAccountPasswordRequestSchema,
  UpdateAccountProfileRequestSchema,
} from '@/domain/schemas';
import { Schema } from 'effect';

const invalid = () =>
  Response.json(
    {
      code: 'validation_error',
      // Parse errors can contain submitted secrets; never return their details.
      message: 'The submitted account fields are invalid.',
    },
    { status: 422 },
  );

export const createAccountAuthEndpoints = (
  getAuth: (request: Request) => Auth,
  environment: Env,
) => {
  const forward = async (request: Request, body: unknown) => {
    try {
      const auth = getAuth(request);
      const identity = await requireSessionIdentity(request, auth, environment);
      if (!identity.session) {
        throw new UnauthorizedError();
      }

      const url = new URL(request.url);
      url.pathname = `/api/auth${url.pathname}`;
      return await auth.handler(
        new Request(url, {
          body: JSON.stringify(body),
          headers: request.headers,
          method: request.method,
        }),
      );
    } catch (error) {
      if (error instanceof AuthConfigurationError) {
        return authenticationNotConfiguredResponse();
      }

      if (error instanceof UnauthorizedError) {
        return Response.json(
          { code: 'unauthorized', message: error.message },
          { status: 401 },
        );
      }

      throw error;
    }
  };

  const updateUser = async (request: Request, raw: string) => {
    let body;
    try {
      const value: unknown = JSON.parse(raw);
      const normalized =
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        'name' in value &&
        typeof value.name === 'string'
          ? { ...value, name: value.name.trim() }
          : value;
      body = Schema.decodeUnknownSync(UpdateAccountProfileRequestSchema, {
        onExcessProperty: 'error',
      })(normalized);
    } catch {
      return invalid();
    }

    return forward(request, body);
  };

  const changePassword = async (request: Request, raw: string) => {
    let body;
    try {
      // Ignore any requested revocation preference; the server always rotates.
      const value: unknown = JSON.parse(raw);
      const normalized =
        value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(
              Object.entries(value).filter(
                ([key]) => key !== 'revokeOtherSessions',
              ),
            )
          : value;
      body = Schema.decodeUnknownSync(ChangeAccountPasswordRequestSchema, {
        onExcessProperty: 'error',
      })(normalized);
    } catch {
      return invalid();
    }

    return forward(request, { ...body, revokeOtherSessions: true });
  };

  return { changePassword, updateUser };
};
