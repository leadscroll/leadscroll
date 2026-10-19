/**
 * Effect-native metrics with a Workers Logs sink.
 *
 * Effect records the measurements in the runtime metric registry, and every
 * event also emits one bounded structured line. Workers Logs is therefore the
 * default sink: self-hosted installations need no collector, and an optional
 * OTLP exporter only extends traces.
 *
 * Dimensions are a closed set. Metric names, outcomes, providers and lead
 * entry points are application constants, so no lead, recipient, address, or
 * free-form field can reach a metric line.
 */

import { Effect, Metric } from 'effect';

export type DeliveryOutcome = 'accepted' | 'failed' | 'skipped';
export type LeadEntry = 'intake' | 'manual';
export type Provider = 'cloudflare' | 'resend';

type Dimensions = {
  readonly entry?: LeadEntry;
  readonly outcome?: DeliveryOutcome;
  readonly provider?: Provider;
};

const leadCreated = Metric.counter('leadscroll_lead_created_total', {
  description: 'New leads committed, by entry point.',
  incremental: true,
});

const notificationDelivery = Metric.counter(
  'leadscroll_notification_delivery_total',
  {
    description: 'Per-recipient notification delivery outcomes.',
    incremental: true,
  },
);

const providerTimeout = Metric.counter('leadscroll_provider_timeout_total', {
  description: 'Provider sends that timed out and are ambiguous.',
  incremental: true,
});

const providerAmbiguous = Metric.counter(
  'leadscroll_provider_ambiguous_total',
  {
    description: 'Provider sends whose acceptance could not be confirmed.',
    incremental: true,
  },
);

const providerDuration = Metric.histogram(
  'leadscroll_provider_send_duration_ms',
  {
    boundaries: [25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000],
    description: 'Provider send latency in milliseconds.',
  },
);

const emit = (metric: string, value: number, dimensions: Dimensions): void => {
  // eslint-disable-next-line no-console -- Workers Logs is the default metric sink.
  console.log(
    JSON.stringify({
      event: 'telemetry.metric',
      metric,
      value,
      ...dimensions,
    }),
  );
};

export const recordLeadCreated = (
  entry: LeadEntry,
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    yield* Metric.update(Metric.withAttributes(leadCreated, { entry }), 1);
    yield* Effect.sync(() => {
      emit('lead.created', 1, { entry });
    });
  });

export const recordNotificationDelivery = (
  outcome: DeliveryOutcome,
  provider: Provider | undefined,
  count: number,
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    if (count <= 0) {
      return;
    }

    const dimensions: Dimensions =
      provider === undefined ? { outcome } : { outcome, provider };
    yield* Metric.update(
      Metric.withAttributes(notificationDelivery, dimensions),
      count,
    );
    yield* Effect.sync(() => {
      emit('notification.delivery', count, dimensions);
    });
  });

export const recordProviderDuration = (
  provider: Provider,
  milliseconds: number,
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    const value = Number.isFinite(milliseconds)
      ? Math.max(0, Math.round(milliseconds))
      : 0;
    yield* Metric.update(
      Metric.withAttributes(providerDuration, { provider }),
      value,
    );
    yield* Effect.sync(() => {
      emit('provider.send.duration_ms', value, { provider });
    });
  });

export const recordProviderAmbiguous = (
  provider: Provider,
  reason: string,
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    yield* Metric.update(
      Metric.withAttributes(providerAmbiguous, { provider }),
      1,
    );
    if (reason === 'timeout') {
      yield* Metric.update(
        Metric.withAttributes(providerTimeout, { provider }),
        1,
      );
    }

    yield* Effect.sync(() => {
      emit('provider.ambiguous', 1, { provider });
    });
  });
