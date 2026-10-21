/**
 * W3C trace-context parsing and identifier helpers.
 *
 * Incoming `traceparent` is honored only when it is a valid version-00
 * header with non-zero identifiers. Invalid headers are ignored rather than
 * rejected: tracing must never affect request handling.
 */

export type TraceContext = {
  readonly sampled: boolean;
  readonly spanId: string;
  readonly traceId: string;
};

const TRACEPARENT = /^([\da-f]{2})-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})$/u;
const ZERO_TRACE_ID = '00000000000000000000000000000000';
const ZERO_SPAN_ID = '0000000000000000';

const randomHex = (bytes: number): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');

export const randomTraceId = (): string => randomHex(16);
export const randomSpanId = (): string => randomHex(8);

/**
 * Parses a W3C `traceparent` header. Returns null when the header is absent
 * or invalid, including all-zero identifiers and unsupported versions.
 */
export const parseTraceparent = (value: null | string): null | TraceContext => {
  if (value === null) {
    return null;
  }

  const match = TRACEPARENT.exec(value.trim());
  if (match === null) {
    return null;
  }

  const [, version, traceId, spanId, flags] = match;
  if (
    version !== '00' ||
    traceId === undefined ||
    spanId === undefined ||
    flags === undefined ||
    traceId === ZERO_TRACE_ID ||
    spanId === ZERO_SPAN_ID
  ) {
    return null;
  }

  return {
    sampled: Number.parseInt(flags, 16) % 2 === 1,
    spanId,
    traceId,
  };
};

export const traceparentFor = (trace: TraceContext): string =>
  `00-${trace.traceId}-${trace.spanId}-${trace.sampled ? '01' : '00'}`;
