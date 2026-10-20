import {
  ApiBadRequestError,
  ApiConflictError,
  ApiInternalError,
  ApiPayloadTooLargeError,
  ApiUnauthorizedError,
  ApiUnsupportedMediaTypeError,
  ApiValidationError,
} from '../errors';
import { runBoundary, webRequest } from '../handler-utilities';
import { parseIntakeBody } from '../intake-parser';
import { type NotificationDispatcherShape, publisherFor } from '../services';
import { createIntakeCommand } from '@/application/commands';
import { bearerToken } from '@/auth/access';
import { type Env, isBrowserIntakeToken, isIntakeToken } from '@/db/repository';
import { isIntakeKey } from '@/domain/intake';
import { IntakeRequestSchema } from '@/domain/schemas';
import { Effect, Schema } from 'effect';
import { type HttpServerRequest } from 'effect/http';

type HandlerOptions = {
  dispatcher: NotificationDispatcherShape;
  environment: Env;
};

type RequestArguments = {
  request: HttpServerRequest.HttpServerRequest;
};

type TokenArguments = RequestArguments & { params: { token: string } };

const intakeBodyError = (response: Response) => {
  switch (response.status) {
    case 400:
      return new ApiBadRequestError({
        code: 'validation_error',
        message: 'The request is invalid.',
      });
    case 413:
      return new ApiPayloadTooLargeError({
        code: 'payload_too_large',
        message: 'The intake request body is too large.',
      });
    case 415:
      return new ApiUnsupportedMediaTypeError({
        code: 'unsupported_media_type',
        message: 'Use Content-Type: application/json for intake requests.',
      });
    default:
      return new ApiInternalError({
        code: 'internal_error',
        message: 'The intake request could not be completed.',
      });
  }
};

const decodeIntake = (raw: unknown) =>
  Schema.decodeUnknownEffect(IntakeRequestSchema)(raw).pipe(
    Effect.mapError(
      () =>
        new ApiValidationError({
          code: 'validation_error',
          message: 'The request is invalid.',
        }),
    ),
  );

const readIntake = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const web = yield* webRequest(request);
    const body = yield* Effect.promise(() => parseIntakeBody(web));
    if ('error' in body) {
      return yield* Effect.fail(intakeBodyError(body.error));
    }

    return { raw: body.data, web };
  });

const idempotencyKeyFor = (request: Request, prefix?: string) => {
  const raw = request.headers.get('Idempotency-Key');
  if (raw === null || raw.length === 0) {
    return new ApiBadRequestError({
      code: 'idempotency_key_required',
      message: 'Idempotency-Key is required.',
    });
  }

  if (!isIntakeKey(raw)) {
    return new ApiBadRequestError({
      code: 'invalid_idempotency_key',
      message:
        'Idempotency-Key must be 1-128 printable ASCII characters (no spaces).',
    });
  }

  return prefix === undefined ? raw : `${prefix}:${raw}`;
};

export const createIntakeHandlers = (options: HandlerOptions) => {
  const { dispatcher, environment } = options;

  return {
    createIntake: ({ request }: RequestArguments) =>
      Effect.gen(function* () {
        const body = yield* readIntake(request);
        const token = bearerToken(body.web);
        const tokenRecord = token
          ? yield* Effect.promise(() => isIntakeToken(environment, token))
          : null;
        if (tokenRecord === null) {
          return yield* Effect.fail(
            new ApiUnauthorizedError({
              code: 'unauthorized',
              message: 'A valid intake token is required.',
            }),
          );
        }

        const key = idempotencyKeyFor(body.web);
        if (key instanceof ApiBadRequestError) {
          return yield* Effect.fail(key);
        }

        const input = yield* decodeIntake(body.raw);
        const result = yield* runBoundary(
          request,
          createIntakeCommand(
            environment,
            input,
            key,
            {
              origin: body.web.headers.get('Origin'),
              tokenId: tokenRecord.id,
            },
            body.raw,
            publisherFor(dispatcher, body.web),
          ),
        );

        switch (result.kind) {
          case 'conflict':
            return yield* Effect.fail(
              new ApiConflictError({
                code: 'idempotency_conflict',
                message:
                  'This Idempotency-Key has already been used with a different payload. Reconcile the stored response before resubmitting.',
              }),
            );
          case 'created':
          case 'replayed':
            return { data: result.response };
          case 'legacy_unverifiable':
            return yield* Effect.fail(
              new ApiConflictError({
                code: 'idempotency_legacy_unverifiable',
                details:
                  typeof result.storedResponse.leadId === 'string'
                    ? { leadId: result.storedResponse.leadId }
                    : undefined,
                message:
                  'This Idempotency-Key was accepted before request fingerprints existed and cannot be verified. Reconcile it against the already stored lead before submitting again.',
              }),
            );
          default:
            return yield* Effect.fail(
              new ApiInternalError({
                code: 'internal_error',
                message: 'The intake request could not be completed.',
              }),
            );
        }
      }),

    createPublicIntake: ({ params, request }: TokenArguments) =>
      Effect.gen(function* () {
        const body = yield* readIntake(request);
        const tokenRecord = yield* Effect.promise(() =>
          isBrowserIntakeToken(environment, params.token),
        );
        if (tokenRecord === null) {
          return yield* Effect.fail(
            new ApiUnauthorizedError({
              code: 'invalid_token',
              message: 'A valid browser intake token is required.',
            }),
          );
        }

        const clientKey =
          body.web.headers.get('Idempotency-Key') ?? crypto.randomUUID();
        if (!isIntakeKey(clientKey)) {
          return yield* Effect.fail(
            new ApiBadRequestError({
              code: 'invalid_idempotency_key',
              message:
                'Idempotency-Key must be 1-128 printable ASCII characters (no spaces).',
            }),
          );
        }

        const key = `browser:${tokenRecord.id}:${clientKey}`;
        const input = yield* decodeIntake(body.raw);
        const result = yield* runBoundary(
          request,
          createIntakeCommand(
            environment,
            input,
            key,
            {
              origin: body.web.headers.get('Origin'),
              tokenId: tokenRecord.id,
            },
            body.raw,
            publisherFor(dispatcher, body.web),
          ),
        );

        switch (result.kind) {
          case 'conflict':
            return yield* Effect.fail(
              new ApiConflictError({
                code: 'idempotency_conflict',
                message:
                  'This submission was already accepted with a different payload.',
              }),
            );
          case 'created':
          case 'replayed':
            return { data: { created: true as const } };
          case 'legacy_unverifiable':
            return yield* Effect.fail(
              new ApiConflictError({
                code: 'idempotency_legacy_unverifiable',
                message:
                  'This submission cannot be verified. Please use a new submission key.',
              }),
            );
          default:
            return yield* Effect.fail(
              new ApiInternalError({
                code: 'internal_error',
                message: 'The intake request could not be completed.',
              }),
            );
        }
      }),

    publicIntakeOptions: () => Effect.succeed(undefined),
  };
};
