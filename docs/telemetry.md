# Telemetry

LeadScroll has two telemetry sinks:

1. **Workers Logs (default).** Every API request emits one JSON line, every
   notification event emits one JSON line, and each metric emits one bounded
   `telemetry.metric` line. No collector, SDK, or paid service is required.
2. **Optional OTLP/HTTP traces.** When an OTLP endpoint is configured, Effect
   spans for the HTTP request, lead creation, notification dispatch, email test,
   and provider send are exported as OTLP/HTTP JSON.

Tracing is off unless an endpoint is configured. Metrics and structured logs
remain on; they are the operator-visible default.

## Enable OTLP trace export

Set these as Worker variables or secrets, then redeploy:

| Variable | Meaning |
| --- | --- |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Exact OTLP/HTTP traces endpoint. Takes precedence over the base endpoint. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base endpoint; `/v1/traces` is appended when missing. |
| `OTEL_EXPORTER_OTLP_HEADERS` | Comma-separated `key=value` headers, for example a collector token. Never logged. |
| `OTEL_TRACES_SAMPLER` | `always_on`, `always_off`, or omitted for head sampling. |
| `OTEL_TRACES_SAMPLER_ARG` | Head sample rate from `0` to `1`. Defaults to `0.1` when an endpoint is set. |
| `OTEL_SERVICE_NAME` | Resource `service.name`. Defaults to `leadscroll`. |

Example:

```sh
pnpm exec wrangler secret put OTEL_EXPORTER_OTLP_HEADERS
# authorization=Bearer <collector-token>

# Optional non-secret variables in wrangler.jsonc
# OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.example.com
# OTEL_TRACES_SAMPLER_ARG=0.1
```

`OTEL_TRACES_SAMPLER=always_off` is a hard switch and takes precedence over the
sample rate.

## Trace correlation

When tracing is enabled, request and notification log lines carry `traceId` and
`spanId`. An incoming W3C `traceparent` header is honored: the request spans
inherit its trace id, and the incoming span becomes the parent. Invalid
`traceparent` headers are ignored and never fail a request.

```json
{"event":"request","method":"GET","path":"/v1/leads","status":200,"durationMs":3.42,"traceId":"4bf92f3577b34da6a3ce929d0e0e4736","spanId":"00b960fe851c7c33"}
```

The notification subscriber opens a `notification.dispatch` span under the
request trace, so background email work is correlated with the lead that
triggered it.

## Metrics

These Effect metrics are recorded and also emitted as bounded
`telemetry.metric` lines:

| Metric | Dimensions | Meaning |
| --- | --- | --- |
| `lead.created` | `entry` (`manual`/`intake`) | New leads committed. |
| `notification.delivery` | `outcome` (`accepted`/`failed`/`skipped`), optional `provider` | Per-recipient notification outcomes. |
| `provider.send.duration_ms` | `provider` | Provider send latency histogram. |
| `provider.ambiguous` | `provider` | Sends whose acceptance could not be confirmed. |
| `provider.timeout` | `provider` | Ambiguous sends caused by a timeout. |

Metric dimensions are a closed set. No lead, recipient, address, custom field,
note, provider response, or free-form reason is used as a dimension.

## Privacy and failure behavior

- Spans export an allowlist of attributes: HTTP method, redacted pathname,
  response status, lead entry point, notification event, provider, and an error
  class. Query strings, public intake tokens, credentials, recipient emails,
  lead payloads, provider response bodies, and SQL values are never exported.
- Log sinks apply the existing redaction rules. Public intake tokens in paths
  become `/v1/public/intakes/:token`; failure messages are not logged.
- Export is best-effort. A collector failure is logged as a redacted
  `telemetry.export_failed` line with an error class and never fails a lead or
  notification request.
- The HTTP export is scheduled through the Worker's `waitUntil`, so the response
  does not wait for a collector.
- At most 200 spans per trace are buffered; excess spans are dropped rather than
  growing memory without bound.

## Why not add an OpenTelemetry SDK or evlog?

The exporter is deliberately a small OTLP/HTTP JSON encoder instead of the
OpenTelemetry SDK. The default build stays dependency-free for Workers Free CPU
limits, and the exporter has no runtime setup when tracing is off.

`evlog` (including `evlog/workers` and the former `evlog/elysia` adapter) was
evaluated and not adopted. The HTTP boundary now uses Effect's own router, so an
Elysia adapter no longer applies; the existing request/notification logger
already enforces the redaction contract; and evlog would add a second
logging/telemetry model without replacing custom logging with a clear benefit.
Effect's own tracing and metrics cover the span/metric work here.

## Disable tracing

Remove `OTEL_EXPORTER_OTLP_ENDPOINT` and
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, or set
`OTEL_TRACES_SAMPLER=always_off`. Structured logs and metrics continue.
