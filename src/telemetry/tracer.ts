/**
 * Effect-native tracing with a Workers-friendly default.
 *
 * The native in-memory tracer is replaced by a small exporter that:
 * - keeps the default build dependency-free (no OpenTelemetry SDK),
 * - records spans only when an OTLP endpoint is configured,
 * - exports an allowlisted subset of attributes as OTLP/HTTP JSON,
 * - never lets an export failure affect the request or notification work.
 *
 * Spans are buffered per trace id and flushed by the request boundary (HTTP)
 * or by the notification subscriber when background work completes.
 */

import {
  type TelemetryConfig,
  telemetryConfig,
  tracingEnabled,
} from './config';
import { type TraceContext } from './trace-context';
import { type Env } from '@/db/env';
import {
  Cause,
  Context,
  Exit,
  Option,
  Tracer,
  type Tracer as TracerModule,
} from 'effect';

const MAX_SPANS_PER_TRACE = 200;

const SAFE_SPAN_ATTRIBUTES = new Set([
  'email.provider',
  'error.type',
  'http.request.method',
  'http.response.status_code',
  'lead.entry',
  'notification.event',
  'url.pathname',
]);

const OTEL_SPAN_KIND: Record<TracerModule.SpanKind, number> = {
  client: 3,
  consumer: 5,
  internal: 1,
  producer: 4,
  server: 2,
};

type OtlpAttribute = {
  readonly key: string;
  readonly value: OtlpAttributeValue;
};

type OtlpAttributeValue =
  | { readonly boolValue: boolean }
  | { readonly doubleValue: number }
  | { readonly intValue: string }
  | { readonly stringValue: string };

type OtlpSpan = {
  readonly attributes: readonly OtlpAttribute[];
  readonly endTimeUnixNano: string;
  readonly kind: number;
  readonly name: string;
  readonly parentSpanId?: string;
  readonly spanId: string;
  readonly startTimeUnixNano: string;
  readonly status: { readonly code: number; readonly message?: string };
  readonly traceId: string;
};

const attributeValue = (value: unknown): null | OtlpAttributeValue => {
  if (typeof value === 'string') {
    return value.length > 512 ? null : { stringValue: value };
  }

  if (typeof value === 'boolean') {
    return { boolValue: value };
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value)
      ? { intValue: String(value) }
      : { doubleValue: value };
  }

  if (typeof value === 'bigint') {
    return { intValue: String(value) };
  }

  return null;
};

const safeAttributes = (span: Tracer.Span): readonly OtlpAttribute[] =>
  Array.from(span.attributes.entries())
    .filter(([key]) => SAFE_SPAN_ATTRIBUTES.has(key))
    .flatMap(([key, value]) => {
      const converted = attributeValue(value);
      return converted === null ? [] : [{ key, value: converted }];
    });

const errorClass = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) {
    return 'none';
  }

  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isSome(failure)) {
    return failure.value instanceof Error
      ? failure.value.name || failure.value.constructor.name
      : typeof failure.value;
  }

  return Cause.hasDies(exit.cause) ? 'Defect' : 'Interrupted';
};

const toOtlpSpan = (span: Tracer.Span): null | OtlpSpan => {
  if (span.status._tag !== 'Ended') {
    return null;
  }

  const failed = Exit.isFailure(span.status.exit);
  const parent = Option.getOrUndefined(span.parent);
  return {
    attributes: safeAttributes(span),
    endTimeUnixNano: String(span.status.endTime),
    kind: OTEL_SPAN_KIND[span.kind],
    name: span.name,
    ...(parent === undefined ? {} : { parentSpanId: parent.spanId }),
    spanId: span.spanId,
    startTimeUnixNano: String(span.status.startTime),
    status: failed
      ? { code: 2, message: errorClass(span.status.exit) }
      : { code: 1 },
    traceId: span.traceId,
  };
};

const otlpPayload = (
  config: TelemetryConfig,
  spans: readonly Tracer.Span[],
): string =>
  JSON.stringify({
    resourceSpans: [
      {
        resource: {
          attributes: [
            {
              key: 'service.name',
              value: { stringValue: config.serviceName },
            },
            {
              key: 'deployment.environment',
              value: { stringValue: config.environment },
            },
          ],
        },
        scopeSpans: [
          {
            scope: { name: 'leadscroll', version: '0.1.0' },
            spans: spans.flatMap((span) => {
              const converted = toOtlpSpan(span);
              return converted === null ? [] : [converted];
            }),
          },
        ],
      },
    ],
  });

export type TelemetryExporter = (
  config: TelemetryConfig,
  spans: readonly Tracer.Span[],
) => Promise<void>;

/**
 * Default exporter: OTLP/HTTP JSON with the configured endpoint and headers.
 * Failure is reported as a redacted class-only log line and swallowed.
 */
const defaultExporter: TelemetryExporter = async (config, spans) => {
  if (config.endpoint === null || spans.length === 0) {
    return;
  }

  try {
    const response = await fetch(config.endpoint, {
      body: otlpPayload(config, spans),
      headers: {
        'content-type': 'application/json',
        ...config.headers,
      },
      method: 'POST',
    });
    // A collector rejection is not a request failure. Never read or log the
    // response body: it may echo a trace payload.
    if (!response.ok) {
      // eslint-disable-next-line no-console -- Redacted exporter failure line.
      console.error(
        JSON.stringify({
          errorClass: 'TelemetryExportRejected',
          event: 'telemetry.export_failed',
          status: response.status,
        }),
      );
    }
  } catch (error) {
    // eslint-disable-next-line no-console -- Redacted exporter failure line.
    console.error(
      JSON.stringify({
        errorClass:
          error instanceof Error
            ? error.name || error.constructor.name
            : typeof error,
        event: 'telemetry.export_failed',
      }),
    );
  }
};

export type Telemetry = {
  readonly config: TelemetryConfig;
  readonly enabled: boolean;
  readonly exportTrace: (
    traceId: string,
    schedule?: (promise: Promise<unknown>) => void,
  ) => Promise<void>;
  readonly makeRootSpan: (options: {
    readonly attributes: Readonly<Record<string, number | string>>;
    readonly kind: TracerModule.SpanKind;
    readonly name: string;
    readonly parent: null | TraceContext;
    readonly sampled: boolean;
    readonly startTime: bigint;
  }) => Tracer.Span;
  readonly sampled: () => boolean;
  readonly tracer: Tracer.Tracer;
};

class RecordingSpan extends Tracer.NativeSpan {
  private ended = false;

  constructor(
    options: ConstructorParameters<typeof Tracer.NativeSpan>[0],
    private readonly onEnd: (span: Tracer.Span) => void,
  ) {
    super(options);
  }

  override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    if (this.ended) {
      return;
    }

    this.ended = true;
    super.end(endTime, exit);
    this.onEnd(this);
  }
}

class TraceBuffer {
  private readonly spansByTrace = new Map<string, Tracer.Span[]>();

  record(span: Tracer.Span): void {
    if (!span.sampled) {
      return;
    }

    const spans = this.spansByTrace.get(span.traceId) ?? [];
    if (spans.length >= MAX_SPANS_PER_TRACE) {
      return;
    }

    spans.push(span);
    this.spansByTrace.set(span.traceId, spans);
  }

  take(traceId: string): readonly Tracer.Span[] {
    const spans = this.spansByTrace.get(traceId) ?? [];
    this.spansByTrace.delete(traceId);
    return spans;
  }
}

const disabledTelemetry = (config: TelemetryConfig): Telemetry => ({
  config,
  enabled: false,
  exportTrace: () => Promise.resolve(),
  makeRootSpan: () => {
    throw new Error('Tracing is disabled.');
  },
  sampled: () => false,
  tracer: Tracer.nativeTracer,
});

const makeTelemetry = (
  config: TelemetryConfig,
  exporter: TelemetryExporter,
): Telemetry => {
  const buffer = new TraceBuffer();
  const enabled = tracingEnabled(config);

  const tracer = Tracer.make({
    span(options) {
      const parent = options.parent;
      const sampled = Option.isSome(parent)
        ? parent.value.sampled && options.sampled
        : options.sampled && enabled && Math.random() < config.sampleRate;

      return new RecordingSpan({ ...options, sampled }, (span) => {
        buffer.record(span);
      });
    },
  });

  const makeRootSpan: Telemetry['makeRootSpan'] = (options) => {
    const parent =
      options.parent === null
        ? Option.none<Tracer.AnySpan>()
        : Option.some(
            Tracer.externalSpan({
              annotations: Context.empty(),
              sampled: options.parent.sampled,
              spanId: options.parent.spanId,
              traceId: options.parent.traceId,
            }),
          );
    const span = new RecordingSpan(
      {
        annotations: Context.empty(),
        kind: options.kind,
        links: [],
        name: options.name,
        parent,
        sampled: options.sampled,
        startTime: options.startTime,
      },
      (ended) => {
        buffer.record(ended);
      },
    );
    for (const [key, value] of Object.entries(options.attributes)) {
      span.attribute(key, value);
    }

    return span;
  };

  return {
    config,
    enabled,
    exportTrace: (traceId, schedule) => {
      const spans = buffer.take(traceId);
      if (spans.length === 0) {
        return Promise.resolve();
      }

      const promise = (async () => {
        try {
          await exporter(config, spans);
        } catch (error) {
          // eslint-disable-next-line no-console -- Redacted exporter failure line.
          console.error(
            JSON.stringify({
              errorClass:
                error instanceof Error
                  ? error.name || error.constructor.name
                  : typeof error,
              event: 'telemetry.export_failed',
            }),
          );
        }
      })();
      if (schedule !== undefined) {
        schedule(promise);
        return Promise.resolve();
      }

      return promise;
    },
    makeRootSpan,
    sampled: () => enabled && Math.random() < config.sampleRate,
    tracer,
  };
};

const telemetryByEnvironment = new WeakMap<Env, Telemetry>();

/**
 * One telemetry instance per Worker environment. The optional exporter is for
 * tests; production always uses the OTLP/HTTP exporter.
 */
export const telemetryForEnvironment = (
  environment: Env,
  exporter: TelemetryExporter = defaultExporter,
): Telemetry => {
  const cached = telemetryByEnvironment.get(environment);
  if (cached !== undefined) {
    return cached;
  }

  const config = telemetryConfig(environment);
  const result = tracingEnabled(config)
    ? makeTelemetry(config, exporter)
    : disabledTelemetry(config);
  telemetryByEnvironment.set(environment, result);
  return result;
};
