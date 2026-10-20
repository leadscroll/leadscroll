# HTTP API contracts

The REST API is declared with Effect `HttpApi` groups in `src/api/contracts.ts`.
Each endpoint declares its params, query, payload, success, and error schemas.
`HttpApi` uses those schemas for runtime decoding, response encoding, typed
clients, and OpenAPI generation.

## Success envelope

Every JSON success response keeps the existing envelope:

```json
{ "data": { "...": "..." } }
```

Creates use `201`, deletes that return no body use `204`, and list/detail
responses keep their existing `nextCursor` or collection fields inside `data`.

## Error envelope

Every API error has the same shape:

```json
{ "code": "revision_conflict", "message": "...", "details": { "...": "..." } }
```

`details` is optional and remains `Schema.Unknown` for now; it is typed per
error only when the UI needs it.

Errors are `Schema.TaggedError` classes in `src/api/errors.ts`, one per HTTP
status:

- `ApiBadRequestError` — 400
- `ApiUnauthorizedError` — 401
- `ApiForbiddenError` — 403
- `ApiNotFoundError` — 404
- `ApiConflictError` — 409
- `ApiPayloadTooLargeError` — 413
- `ApiUnsupportedMediaTypeError` — 415
- `ApiValidationError` — 422
- `ApiRateLimitError` — 429
- `ApiInternalError` — 500
- `ApiServiceUnavailableError` — 503

`_tag` is the reason discriminator; `code` is the application code. There is no
separate `reason` field and no hand-maintained error union: endpoints list the
error classes they can return, and `HttpApi` derives the client union.

Internal `DomainError`, `PersistenceError`, and `PlatformError` values are
mapped to those public classes at the boundary by `toApiError`. `PlatformError`
is the single internal transport/guard failure type and carries the intended
status.

## Middleware

- `StaffAuth` authenticates and authorizes staff routes, provides `CurrentStaff`,
  and maps guard failures to the public error classes.
- `ApiSchemaErrors` maps automatic request-schema decode failures to
  `ApiValidationError` (422) instead of the default schema-error response.
- Better Auth keeps its dedicated `/api/auth` wildcard handler.
- Public intake CORS headers are applied to the `/v1/public/intakes/*` path in
  the HTTP boundary.
- Email settings responses are marked `cache-control: no-store`.

## Raw exceptions

Two route families intentionally keep raw request handling:

- **Intake** (`/v1/intakes`, `/v1/public/intakes/:token`) reads the streamed body
  with the 65,536-byte `get-stream` limit before token checks, then decodes the
  schema. The endpoint still declares the payload schema for clients.
- **Email settings** (`PUT /v1/settings/email`, `POST /v1/settings/email/test`)
  declares the payload schema for clients but uses `handleRaw` server-side so a
  decoder failure can never echo credential material.

## Testing

Use the generated client (`HttpApiClient`) against Miniflare for true
request/response contract tests, and the existing raw HTTP tests for guard,
worker, and persistence behavior. `tests/d1-leads.test.ts` contains the first
generated-client round trip.
