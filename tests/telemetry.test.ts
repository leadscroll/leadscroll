import {
  registerRequestWaitUntil,
  type RequestWaitUntil,
} from '@/api/execution-context';
import { logRequest, markRequestStart } from '@/api/logging';
import { type Env } from '@/db/env';
import { logNotificationEventOutcome } from '@/notifications/logging';
import { telemetryConfig } from '@/telemetry/config';
import { recordLeadCreated } from '@/telemetry/metrics';
import { requestTrace, startRequestTelemetry } from '@/telemetry/request';
import { parseTraceparent } from '@/telemetry/trace-context';
import { Effect } from 'effect';
import { afterEach, describe, expect, test, vi } from 'vitest';

const makeEnv = (overrides: Partial<Env> = {}): Env =>
  ({
    ASSETS: {} as Fetcher,
    BETTER_AUTH_SECRET: 'test-secret',
    DB: {} as Env['DB'],
    ENVIRONMENT: 'test',
    ...overrides,
  }) as Env;

const stubFetch = () =>
  vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));

const takeScheduled = (): {
  promises: Array<Promise<unknown>>;
  waitUntil: RequestWaitUntil;
} => {
  const promises: Array<Promise<unknown>> = [];
  return {
    promises,
    waitUntil: (promise) => {
      promises.push(promise);
    },
  };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('telemetry configuration', () => {
  test('is off unless an OTLP traces endpoint is configured', () => {
    const config = telemetryConfig(makeEnv());
    expect(config.endpoint).toBeNull();
    expect(config.sampleRate).toBe(0.1);
  });

  test('resolves the standard endpoint and header variables', () => {
    const config = telemetryConfig(
      makeEnv({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.test/',
        OTEL_EXPORTER_OTLP_HEADERS:
          'authorization=Bearer%20secret, x-tenant=demo',
        OTEL_SERVICE_NAME: 'leadscroll-test',
        OTEL_TRACES_SAMPLER_ARG: '0.25',
      }),
    );

    expect(config.endpoint).toBe('https://collector.example.test/v1/traces');
    expect(config.headers).toEqual({
      authorization: 'Bearer%20secret',
      'x-tenant': 'demo',
    });
    expect(config.sampleRate).toBe(0.25);
    expect(config.serviceName).toBe('leadscroll-test');
  });

  test('honors always_off and clamps an invalid sample rate', () => {
    expect(
      telemetryConfig(
        makeEnv({
          OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.test',
          OTEL_TRACES_SAMPLER: 'always_off',
          OTEL_TRACES_SAMPLER_ARG: '1',
        }),
      ).sampleRate,
    ).toBe(0);
    expect(
      telemetryConfig(
        makeEnv({
          OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.test',
          OTEL_TRACES_SAMPLER_ARG: '9',
        }),
      ).sampleRate,
    ).toBe(1);
  });
});

describe('trace context', () => {
  test('parses a valid traceparent and rejects malformed or zero ids', () => {
    expect(
      parseTraceparent(
        '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      ),
    ).toEqual({
      sampled: true,
      spanId: '00f067aa0ba902b7',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    });
    expect(
      parseTraceparent(
        '00-00000000000000000000000000000000-00f067aa0ba902b7-01',
      ),
    ).toBeNull();
    expect(
      parseTraceparent(
        '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01',
      ),
    ).toBeNull();
    expect(parseTraceparent('garbage')).toBeNull();
    expect(parseTraceparent(null)).toBeNull();
  });
});

describe('request tracing', () => {
  test('exports allowlisted spans and honors incoming traceparent', async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal('fetch', fetchMock);
    const environment = makeEnv({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.test',
      OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer%20secret',
      OTEL_SERVICE_NAME: 'leadscroll-test',
    });
    const request = new Request(
      'https://leadscroll.test/v1/public/intakes/secret-token?email=alex@example.test',
      {
        headers: {
          traceparent:
            '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        },
        method: 'POST',
      },
    );
    const scheduled = takeScheduled();
    registerRequestWaitUntil(request, scheduled.waitUntil);
    markRequestStart(request);

    const telemetry = startRequestTelemetry(request, environment);
    expect(telemetry).not.toBeNull();
    if (telemetry === null) {
      return;
    }

    expect(telemetry.trace.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');

    await Effect.runPromise(
      telemetry.provide(
        Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan('lead.email', 'alex@example.test');
          yield* Effect.withSpan('lead.create', {
            attributes: { 'lead.entry': 'manual' },
          })(Effect.succeed('created'));
        }),
      ),
    );

    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    telemetry.end(500, 'PersistenceError');
    logRequest(request, 500, { errorClass: 'PersistenceError' });
    const requestLine = JSON.parse(String(log.mock.calls[0]?.[0])) as Record<
      string,
      unknown
    >;
    expect(requestLine).toMatchObject({
      spanId: telemetry.trace.spanId,
      traceId: telemetry.trace.traceId,
    });

    await Promise.all(scheduled.promises);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [endpoint, init] = fetchMock.mock.calls[0] ?? [];
    expect(endpoint).toBe('https://collector.example.test/v1/traces');
    const body = String(init?.body);
    expect(body).not.toContain('secret-token');
    expect(body).not.toContain('alex@example.test');
    expect(body).not.toContain('?email=');

    const payload = JSON.parse(body) as {
      resourceSpans: Array<{
        resource: { attributes: Array<Record<string, unknown>> };
        scopeSpans: Array<{
          spans: Array<{
            attributes: Array<{ key: string; value: Record<string, unknown> }>;
            name: string;
            parentSpanId?: string;
            status: { code: number; message?: string };
            traceId: string;
          }>;
        }>;
      }>;
    };
    const spans = payload.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
    const root = spans.find((span) => span.name === 'http.request');
    const child = spans.find((span) => span.name === 'lead.create');
    expect(root).toMatchObject({
      parentSpanId: '00f067aa0ba902b7',
      status: { code: 2, message: 'PersistenceError' },
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    });
    expect(root?.attributes).toContainEqual({
      key: 'url.pathname',
      value: { stringValue: '/v1/public/intakes/:token' },
    });
    expect(root?.attributes).toContainEqual({
      key: 'http.response.status_code',
      value: { intValue: '500' },
    });
    expect(child?.attributes).toContainEqual({
      key: 'lead.entry',
      value: { stringValue: 'manual' },
    });
    expect(child?.attributes).not.toContainEqual(
      expect.objectContaining({ key: 'lead.email' }),
    );
    expect(String(init?.body)).not.toContain('authorization');
  });

  test('stays off when no endpoint is configured', () => {
    const request = new Request('https://leadscroll.test/v1/leads');
    const telemetry = startRequestTelemetry(request, makeEnv());
    expect(telemetry).toBeNull();
    expect(requestTrace(request)).toBeNull();
  });

  test('an exporter failure never escapes the request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => {
        throw new Error('collector unavailable');
      }),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const environment = makeEnv({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.test',
      OTEL_TRACES_SAMPLER: 'always_on',
    });
    const request = new Request('https://leadscroll.test/v1/leads');
    const scheduled = takeScheduled();
    registerRequestWaitUntil(request, scheduled.waitUntil);

    const telemetry = startRequestTelemetry(request, environment);
    expect(telemetry).not.toBeNull();
    telemetry?.end(200);

    await expect(Promise.all(scheduled.promises)).resolves.toBeDefined();
    expect(errorSpy).toHaveBeenCalled();
    const line = JSON.parse(String(errorSpy.mock.calls[0]?.[0])) as Record<
      string,
      unknown
    >;
    expect(line).toMatchObject({
      errorClass: 'Error',
      event: 'telemetry.export_failed',
    });
  });
});

describe('telemetry sinks', () => {
  test('notification lines carry trace ids when tracing is enabled', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    logNotificationEventOutcome({
      eventKind: 'lead.created',
      leadId: 'lead-1',
      outcome: 'skipped',
      reasonCode: 'disabled',
      trace: { spanId: 'span-1', traceId: 'trace-1' },
    });
    const line = JSON.parse(String(log.mock.calls[0]?.[0])) as Record<
      string,
      unknown
    >;
    expect(line).toMatchObject({
      spanId: 'span-1',
      traceId: 'trace-1',
    });
  });

  test('metric lines are bounded and free of payload data', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await Effect.runPromise(recordLeadCreated('manual'));
    const line = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as Record<
      string,
      unknown
    >;
    expect(line).toMatchObject({
      entry: 'manual',
      event: 'telemetry.metric',
      metric: 'lead.created',
      value: 1,
    });
    expect(Object.keys(line).toSorted()).toEqual([
      'entry',
      'event',
      'metric',
      'value',
    ]);
  });
});
