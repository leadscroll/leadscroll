import { createApp } from './api/app';
import { registerRequestWaitUntil } from './api/execution-context';
import { logRequest, markRequestStart } from './api/logging';
import { type Env as Environment } from './db/repository';
import { startRequestTelemetry } from './telemetry/request';
import { env } from 'cloudflare:workers';

const workerEnvironment = env as unknown as Environment;
const app = createApp(workerEnvironment).compile();
const API_PATHS = ['/v1/', '/api/auth/', '/api/invites/', '/health'];

export default {
  async fetch(
    request: Request,
    _environment?: Environment,
    context?: ExecutionContext,
  ): Promise<Response> {
    // Intake bodies are bounded to 65,536 actual bytes by the Elysia intake
    // route's get-stream-backed parse hook, so the entry forwards requests
    // untouched and performs no route matching of its own.
    //
    // The commit that created a lead schedules best-effort notification work
    // through this bound waitUntil. The registration is per request and is
    // looked up by the request-scoped event publisher; there is no global
    // "current request" state. A Worker interruption can still lose an alert.
    // Direct callers without a Worker context (tests/probes) get no
    // registration: the publisher logs `scheduling_failed` and the committed
    // lead still succeeds.
    if (context !== undefined) {
      registerRequestWaitUntil(request, (promise) => {
        context.waitUntil(promise);
      });
    }

    const pathname = new URL(request.url).pathname;
    if (
      API_PATHS.some((path) => pathname === path || pathname.startsWith(path))
    ) {
      // One structured JSON line per API request, emitted before the
      // response is returned so it survives isolate suspension. See
      // src/api/logging.ts for the fields and the privacy rules.
      markRequestStart(request);
      const telemetry = startRequestTelemetry(request, workerEnvironment);
      let response: Response;
      try {
        response = await app.handle(request);
      } catch (error) {
        const errorClass =
          error instanceof Error
            ? error.name || error.constructor.name
            : typeof error;
        telemetry?.end(500, errorClass);
        logRequest(request, 500, {
          errorClass,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      telemetry?.end(response.status);
      logRequest(request, response.status);
      return response;
    }

    return workerEnvironment.ASSETS.fetch(request);
  },
};
