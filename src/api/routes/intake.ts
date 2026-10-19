import {
  errorResponse,
  type EventsFor,
  parse,
  PUBLIC_CORS_HEADERS,
  type RunRequest,
  withPublicCors,
} from '../http';
import { mapIntakeBodyError, parseIntakeBody } from '../intake-parser';
import { createIntakeCommand } from '@/application/commands';
import { bearerToken } from '@/auth/access';
import { type Env, isBrowserIntakeToken, isIntakeToken } from '@/db/repository';
import { isIntakeKey } from '@/domain/intake';
import { IntakeRequestSchema } from '@/domain/schemas';
import { Elysia } from 'elysia';

type IntakeRoutesOptions = {
  environment: Env;
  eventsFor: EventsFor;
  runRequest: RunRequest;
};

export const createIntakeRoutes = (options: IntakeRoutesOptions) => {
  const { environment, eventsFor, runRequest } = options;

  const publicIntake = new Elysia({ name: 'public-intake' })
    .options(
      '/v1/public/intakes/:token',
      () => new Response(null, { headers: PUBLIC_CORS_HEADERS, status: 204 }),
    )
    .post(
      '/v1/public/intakes/:token',
      async ({ body, params, request }) => {
        const tokenRecord = await isBrowserIntakeToken(
          environment,
          params.token,
        );
        if (!tokenRecord) {
          return withPublicCors(
            errorResponse(
              401,
              'invalid_token',
              'A valid browser intake token is required.',
            ),
          );
        }

        const clientKey =
          request.headers.get('Idempotency-Key') ?? crypto.randomUUID();
        if (!isIntakeKey(clientKey)) {
          return withPublicCors(
            errorResponse(
              400,
              'invalid_idempotency_key',
              'Idempotency-Key must be 1-128 printable ASCII characters (no spaces).',
            ),
          );
        }

        // Browser keys are namespaced per token so they can never collide with
        // keys an API integration chose for `/v1/intakes`.
        const idempotencyKey = `browser:${tokenRecord.id}:${clientKey}`;

        const parsed = await parse(IntakeRequestSchema, body);
        if ('error' in parsed) {
          return withPublicCors(parsed.error);
        }

        const result = await runRequest(
          request,
          createIntakeCommand(
            environment,
            parsed.data,
            idempotencyKey,
            {
              origin: request.headers.get('Origin'),
              tokenId: tokenRecord.id,
            },
            body,
            eventsFor(request),
          ),
        );
        if ('error' in result) {
          return withPublicCors(result.error);
        }

        switch (result.data.kind) {
          case 'conflict':
            return withPublicCors(
              errorResponse(
                409,
                'idempotency_conflict',
                'This submission was already accepted with a different payload.',
              ),
            );
          case 'created':
          case 'replayed':
            // The public surface stays minimal: no lead id is returned.
            return withPublicCors(
              Response.json({ data: { created: true } }, { status: 201 }),
            );
          case 'legacy_unverifiable':
            return withPublicCors(
              errorResponse(
                409,
                'idempotency_legacy_unverifiable',
                'This submission cannot be verified. Please use a new submission key.',
              ),
            );
        }

        return withPublicCors(
          errorResponse(
            500,
            'internal_error',
            'The intake request could not be completed.',
          ),
        );
      },
      {
        error: ({ error }) =>
          mapIntakeBodyError(error, (code, response) =>
            withPublicCors(Response.json(response, { status: code })),
          ),
        parse: parseIntakeBody,
      },
    );

  return new Elysia({ name: 'intake-routes' })
    .post(
      '/v1/intakes',
      async ({ body, request }) => {
        const token = bearerToken(request);
        const tokenRecord = token
          ? await isIntakeToken(environment, token)
          : null;
        if (!tokenRecord) {
          return errorResponse(
            401,
            'unauthorized',
            'A valid intake token is required.',
          );
        }

        const idempotencyKey = request.headers.get('Idempotency-Key');
        if (!idempotencyKey) {
          return errorResponse(
            400,
            'idempotency_key_required',
            'Idempotency-Key is required.',
          );
        }

        if (!isIntakeKey(idempotencyKey)) {
          return errorResponse(
            400,
            'invalid_idempotency_key',
            'Idempotency-Key must be 1-128 printable ASCII characters (no spaces).',
          );
        }

        const parsed = await parse(IntakeRequestSchema, body);
        if ('error' in parsed) {
          return parsed.error;
        }

        const result = await runRequest(
          request,
          createIntakeCommand(
            environment,
            parsed.data,
            idempotencyKey,
            {
              origin: request.headers.get('Origin'),
              tokenId: tokenRecord.id,
            },
            body,
            eventsFor(request),
          ),
        );
        if ('error' in result) {
          return result.error;
        }

        switch (result.data.kind) {
          case 'conflict':
            return errorResponse(
              409,
              'idempotency_conflict',
              'This Idempotency-Key has already been used with a different payload. Reconcile the stored response before resubmitting.',
            );
          case 'created':
          case 'replayed':
            // Replays keep the original HTTP 201 and stored response for
            // compatibility, without touching leads or history.
            return Response.json(
              { data: result.data.response },
              { status: 201 },
            );
          case 'legacy_unverifiable': {
            const stored = result.data.storedResponse;
            return errorResponse(
              409,
              'idempotency_legacy_unverifiable',
              'This Idempotency-Key was accepted before request fingerprints existed and cannot be verified. Reconcile it against the already stored lead before submitting again.',
              typeof stored.leadId === 'string'
                ? { leadId: stored.leadId }
                : undefined,
            );
          }
        }

        // Every kind above returns; this guard only fires if a new outcome
        // kind is added without a handler
        return errorResponse(
          500,
          'internal_error',
          'The intake request could not be completed.',
        );
      },
      {
        error: ({ error, status }) => mapIntakeBodyError(error, status),
        // The raw intake body is bounded to 65,536 actual bytes by the
        // get-stream-backed parse hook BEFORE JSON decoding and domain
        // writes, on every accepted alias of this route. Overflow is mapped
        // to the existing 413 payload_too_large response by the error hook.
        parse: parseIntakeBody,
      },
    )
    .use(publicIntake);
};
