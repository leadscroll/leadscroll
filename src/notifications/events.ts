/**
 * Typed application events for best-effort notifications.
 *
 * The dispatcher is deliberately small: subscriber registration is fixed at
 * composition time, each subscriber is an Effect that is executed on a
 * composition-provided `ManagedRuntime`, and failures are isolated and
 * logged as redacted structured lines. Background work is handed to the
 * Worker execution context via `waitUntil`; this is not a durable bus, and a
 * crash or interrupted execution can lose an alert.
 *
 * The publisher dependency is passed explicitly into the application commands
 * that create leads, so production always wires the real dispatcher and tests
 * can record or await publications without a hidden no-op default.
 */

import { type Deployment } from '@/application/deployment';
import { type InstallationConfigStore } from '@/application/installation-config-store';
import { type CredentialCipher } from '@/notifications/credential-cipher';
import { type EmailProviderResolver } from '@/notifications/email-provider';
import { logNotificationEventOutcome } from '@/notifications/logging';
import { type TraceContext } from '@/telemetry/trace-context';
import { Cause, Effect } from 'effect';
import { type ManagedRuntime } from 'effect/ManagedRuntime';

export const LEAD_CREATED_EVENT = 'lead.created' as const;

/**
 * Minimal identity for one committed lead. `actorUserId` is null for
 * unauthenticated intake and lets the subscriber exclude the manual creator.
 */
export type LeadCreatedEvent = {
  actorUserId: null | string;
  leadId: string;
  /**
   * Request trace context, present only when tracing is enabled.
   */
  trace?: TraceContext;
};

export type LeadCreatedPublisher = {
  publishLeadCreated: (event: LeadCreatedEvent) => void;
  readonly trace: null | TraceContext;
};

export type LeadCreatedSubscriber = (
  event: LeadCreatedEvent,
) => Effect.Effect<void, unknown, NotificationServices>;

export type NotificationEventMap = {
  'lead.created': LeadCreatedEvent;
};

export type NotificationRuntime = ManagedRuntime<NotificationServices, never>;

/**
 * Services notification effects may depend on.
 */
export type NotificationServices =
  | CredentialCipher
  | Deployment
  | EmailProviderResolver
  | InstallationConfigStore;

const causeErrorClass = (cause: Cause.Cause<unknown>): string => {
  const failure = Cause.findErrorOption(cause);
  if (failure._tag === 'Some') {
    const error = failure.value;
    return error instanceof Error
      ? error.name || error.constructor.name
      : typeof error;
  }

  return Cause.hasDies(cause) ? 'Defect' : 'Interrupted';
};

/**
 * Runs every subscriber for one event on the composition runtime. Each
 * subscriber has its own fiber; a failing subscriber is logged and never
 * prevents another subscriber from completing.
 */
export const runLeadCreatedSubscribers = (
  runtime: NotificationRuntime,
  subscribers: readonly LeadCreatedSubscriber[],
  event: LeadCreatedEvent,
): Promise<void> =>
  runtime.runPromise(
    // Yield once so the publisher returns to the request before any subscriber
    // work starts; the Worker still receives the promise through waitUntil.
    Effect.yieldNow.pipe(
      Effect.andThen(
        Effect.forEach(
          subscribers,
          (subscriber) =>
            Effect.suspend(() => subscriber(event)).pipe(
              Effect.catchCause((cause) =>
                Effect.sync(() => {
                  logNotificationEventOutcome({
                    errorClass: causeErrorClass(cause),
                    eventKind: LEAD_CREATED_EVENT,
                    leadId: event.leadId,
                    outcome: 'subscriber_failed',
                  });
                }),
              ),
            ),
          { concurrency: 'unbounded', discard: true },
        ),
      ),
    ),
  );

/**
 * Builds the request-scoped publisher. `waitUntil` must be the runtime's
 * execution-context method (correctly bound), so delivery continues after the
 * HTTP response; a schedule failure is logged and never rethrown into the
 * command that created the lead.
 */
export const createLeadCreatedPublisher = (options: {
  runtime: NotificationRuntime;
  subscribers: readonly LeadCreatedSubscriber[];
  trace?: null | TraceContext;
  waitUntil: (promise: Promise<unknown>) => void;
}): LeadCreatedPublisher => {
  const { runtime, subscribers, trace = null, waitUntil } = options;
  return {
    publishLeadCreated(event) {
      const delivered = trace === null ? event : { ...event, trace };
      try {
        waitUntil(runLeadCreatedSubscribers(runtime, subscribers, delivered));
      } catch (error) {
        logNotificationEventOutcome({
          errorClass:
            error instanceof Error
              ? error.name || error.constructor.name
              : typeof error,
          eventKind: LEAD_CREATED_EVENT,
          leadId: event.leadId,
          outcome: 'scheduling_failed',
          ...(trace === null ? {} : { trace }),
        });
      }
    },
    trace,
  };
};
