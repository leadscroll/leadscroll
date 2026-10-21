/**
 * Per-request Worker execution context plumbing.
 *
 * The HTTP boundary does not expose the Worker `ExecutionContext`, so the fetch
 * entry registers the bound `ctx.waitUntil` against the exact request instance
 * before dispatching. Route composition looks it up when it
 * builds a request-scoped event publisher. A WeakMap keeps each request's
 * lifecycle separate; there is no global "current request" state.
 *
 * A missing registration (for example a test that calls `app.handle(request)`
 * without a Worker context) is not silently ignored: the publisher logs a
 * `scheduling_failed` outcome and the committed lead still succeeds.
 */

export type RequestWaitUntil = (promise: Promise<unknown>) => void;

const waitUntilByRequest = new WeakMap<object, RequestWaitUntil>();

export const registerRequestWaitUntil = (
  request: Request,
  waitUntil: RequestWaitUntil,
): void => {
  waitUntilByRequest.set(request, waitUntil);
};

export const requestWaitUntil = (request: Request): null | RequestWaitUntil =>
  waitUntilByRequest.get(request) ?? null;
