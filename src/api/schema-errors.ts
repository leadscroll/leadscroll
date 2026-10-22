/**
 * Maps automatic request-schema failures to the public 422 validation error.
 * Without this middleware `HttpApi` returns its own 400 schema-error response,
 * which would bypass the API envelope and the generated client error contract.
 */

import { ApiValidationError } from './errors';
import { Effect } from 'effect';
import { HttpApiMiddleware } from 'effect/http-api';

export class ApiSchemaErrors extends HttpApiMiddleware.Service<ApiSchemaErrors>()(
  'leadscroll/api/ApiSchemaErrors',
  { error: ApiValidationError },
) {}

export const ApiSchemaErrorsLayer = HttpApiMiddleware.layerSchemaErrorTransform(
  ApiSchemaErrors,
  () =>
    Effect.fail(
      new ApiValidationError({
        code: 'validation_error',
        message: 'The request is invalid.',
      }),
    ),
);
