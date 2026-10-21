/**
 * Opt-in telemetry configuration.
 *
 * Tracing is disabled unless an OTLP/HTTP traces endpoint is configured. The
 * default sink remains Workers Logs, so a self-hosted installation never needs
 * a collector. This module is pure: it reads the Worker `Env` once per
 * environment and never logs configured endpoints or headers.
 */

import { type Env } from '@/db/env';

export type TelemetryConfig = {
  /**
   * Export traces to this OTLP/HTTP endpoint. Null disables tracing.
   */
  readonly endpoint: null | string;
  readonly environment: string;
  /**
   * Extra OTLP headers (for example a collector token). Never logged.
   */
  readonly headers: Readonly<Record<string, string>>;
  /**
   * Head sampling rate for root spans without an incoming decision.
   */
  readonly sampleRate: number;
  readonly serviceName: string;
};

const DEFAULT_SAMPLE_RATE = 0.1;

const trimmed = (value: string | undefined): null | string => {
  const result = value?.trim() ?? '';
  return result.length === 0 ? null : result;
};

const parseHeaders = (
  value: string | undefined,
): Readonly<Record<string, string>> => {
  const headers: Record<string, string> = {};
  for (const entry of (value ?? '').split(',')) {
    const separator = entry.indexOf('=');
    if (separator <= 0) {
      continue;
    }

    const name = entry.slice(0, separator).trim();
    const headerValue = entry.slice(separator + 1).trim();
    if (name.length === 0 || headerValue.length === 0) {
      continue;
    }

    headers[name] = headerValue;
  }

  return headers;
};

const parseSampleRate = (value: string | undefined): number => {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_SAMPLE_RATE;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_SAMPLE_RATE;
  }

  return Math.min(1, Math.max(0, parsed));
};

const tracesEndpoint = (
  tracesEndpointValue: string | undefined,
  endpointValue: string | undefined,
): null | string => {
  const exact = trimmed(tracesEndpointValue);
  if (exact !== null) {
    return exact;
  }

  const base = trimmed(endpointValue);
  if (base === null) {
    return null;
  }

  return base.replace(/\/+$/u, '').endsWith('/v1/traces')
    ? base.replace(/\/+$/u, '')
    : `${base.replace(/\/+$/u, '')}/v1/traces`;
};

/**
 * Resolves tracing configuration from standard OTEL environment variables.
 * `OTEL_TRACES_SAMPLER=always_off` is an explicit hard off switch.
 */
export const telemetryConfig = (environment: Env): TelemetryConfig => {
  const endpoint = tracesEndpoint(
    environment.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
    environment.OTEL_EXPORTER_OTLP_ENDPOINT,
  );
  const sampler = environment.OTEL_TRACES_SAMPLER?.trim().toLowerCase();
  const sampleRate =
    sampler === 'always_off'
      ? 0
      : sampler === 'always_on'
        ? 1
        : parseSampleRate(environment.OTEL_TRACES_SAMPLER_ARG);

  return {
    endpoint,
    environment: environment.ENVIRONMENT,
    headers: parseHeaders(environment.OTEL_EXPORTER_OTLP_HEADERS),
    sampleRate,
    serviceName: trimmed(environment.OTEL_SERVICE_NAME) ?? 'leadscroll',
  };
};

export const tracingEnabled = (config: TelemetryConfig): boolean =>
  config.endpoint !== null && config.sampleRate > 0;
