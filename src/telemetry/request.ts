/**
 * Request-scoped tracing boundary.
 *
 * The Worker entry starts a root `http.request` span before dispatching to the
 * API. Application effects receive the same tracer and parent span through the
 * request-scoped context, so command spans are children of the HTTP span.
 * Logging reads the registered trace ids through a WeakMap; there is no global
 * "current request" state.
 */

import { parseTraceparent, type TraceContext } from './trace-context';
import { telemetryForEnvironment } from './tracer';
import { requestWaitUntil } from '@/api/execution-context';
import { redactPath } from '@/api/redact';
import { type Env } from '@/db/env';
import { Effect, Exit, Tracer } from 'effect';

export type RequestTelemetry = {
  readonly end: (status: number, errorClass?: string) => void;
  readonly provide: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, Exclude<R, Tracer.ParentSpan>>;
  readonly trace: TraceContext;
};

const telemetryByRequest = new WeakMap<object, RequestTelemetry>();

/**
 * Error value used only to carry a span status. The exporter maps `name` to
 * the allowlisted `error.type`; messages are never exported.
 */
class RequestSpanError extends Error {
  constructor(name: string) {
    super('Request failed.');
    this.name = name;
  }
}

const nowNanos = (): bigint =>
  BigInt(Math.round(performance.now() * 1_000_000));

/**
 * Starts tracing for one request. Returns null when tracing is disabled, so
 * the request path pays only the configuration lookup.
 */
export const startRequestTelemetry = (
  request: Request,
  environment: Env,
): null | RequestTelemetry => {
  const telemetry = telemetryForEnvironment(environment);
  if (!telemetry.enabled) {
    return null;
  }

  const incoming = parseTraceparent(request.headers.get('traceparent'));
  const sampled = incoming?.sampled ?? telemetry.sampled();
  const parent: null | TraceContext =
    incoming === null
      ? null
      : {
          sampled: incoming.sampled,
          spanId: incoming.spanId,
          traceId: incoming.traceId,
        };
  const root = telemetry.makeRootSpan({
    attributes: {
      'http.request.method': request.method,
      'url.pathname': redactPath(new URL(request.url).pathname),
    },
    kind: 'server',
    name: 'http.request',
    parent,
    sampled,
    startTime: nowNanos(),
  });
  const trace: TraceContext = {
    sampled: root.sampled,
    spanId: root.spanId,
    traceId: root.traceId,
  };
  let ended = false;

  const telemetryForRequest: RequestTelemetry = {
    end(status, errorClass) {
      if (ended) {
        return;
      }

      ended = true;
      root.attribute('http.response.status_code', status);
      if (errorClass !== undefined) {
        root.attribute('error.type', errorClass);
      }

      root.end(
        nowNanos(),
        errorClass === undefined
          ? Exit.succeed(undefined)
          : Exit.fail(new RequestSpanError(errorClass)),
      );
      // The response must not wait on a collector. When a Worker execution
      // context exists, the export is part of waitUntil; otherwise it is
      // best-effort and its failure is already swallowed by the exporter.
      const schedule = requestWaitUntil(request);
      if (schedule === null) {
        void telemetry.exportTrace(trace.traceId);
      } else {
        void telemetry.exportTrace(trace.traceId, schedule);
      }
    },
    provide(effect) {
      return Effect.provideService(
        Effect.provideService(effect, Tracer.Tracer, telemetry.tracer),
        Tracer.ParentSpan,
        root,
      );
    },
    trace,
  };
  telemetryByRequest.set(request, telemetryForRequest);
  return telemetryForRequest;
};

export const requestTelemetry = (request: Request): null | RequestTelemetry =>
  telemetryByRequest.get(request) ?? null;

export const requestTrace = (request: Request): null | TraceContext =>
  telemetryByRequest.get(request)?.trace ?? null;
