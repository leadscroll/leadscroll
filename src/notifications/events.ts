/**
 * Typed application events for best-effort notifications.
 *
 * The dispatcher is deliberately small: subscriber registration is fixed at
 * composition time, every subscriber's failure is isolated (synchronous throws
 * and async rejections), and background work is handed to the Worker execution
 * context via `waitUntil`. This is not a durable bus: a crash between the lead
 * commit and publication, or a Worker interruption, can lose an alert. A queue
 * can wrap this boundary later; see docs/email-notifications.md.
 *
 * The publisher dependency is passed explicitly into the application commands
 * that create leads, so production always wires the real dispatcher and tests
 * can record or await publications without a hidden no-op default.
 */

import { logNotificationEventOutcome } from '@/api/logging';
import { type Env } from '@/db/repository';

export const LEAD_CREATED_EVENT = 'lead.created' as const;

/**
 * Minimal identity for one committed lead. `actorUserId` is null for
 * unauthenticated intake and lets the subscriber exclude the manual creator.
 */
export type LeadCreatedEvent = {
  actorUserId: null | string;
  leadId: string;
};

export type LeadCreatedPublisher = {
  publishLeadCreated: (event: LeadCreatedEvent) => void;
};

export type LeadCreatedSubscriber = (
  environment: Env,
  event: LeadCreatedEvent,
) => Promise<void> | void;

export type NotificationEventMap = {
  'lead.created': LeadCreatedEvent;
};

const errorClass = (error: unknown): string =>
  error instanceof Error ? error.name || error.constructor.name : typeof error;

/**
 * Runs every subscriber for one event. `Promise.allSettled` plus an async
 * wrapper isolates synchronous throws and async rejections, so one subscriber
 * cannot prevent another from completing. Failures are logged as redacted
 * structured lines; the committed lead remains successful regardless.
 */
export const runLeadCreatedSubscribers = async (
  environment: Env,
  subscribers: readonly LeadCreatedSubscriber[],
  event: LeadCreatedEvent,
): Promise<void> => {
  const results = await Promise.allSettled(
    subscribers.map(async (subscriber) => subscriber(environment, event)),
  );
  for (const result of results) {
    if (result.status === 'rejected') {
      logNotificationEventOutcome({
        errorClass: errorClass(result.reason),
        eventKind: LEAD_CREATED_EVENT,
        leadId: event.leadId,
        outcome: 'subscriber_failed',
      });
    }
  }
};

/**
 * Builds the request-scoped publisher. `waitUntil` must be the runtime's
 * execution-context method (correctly bound), so delivery continues after the
 * HTTP response; a schedule failure is logged and never rethrown into the
 * command that created the lead.
 */
export const createLeadCreatedPublisher = (options: {
  environment: Env;
  subscribers: readonly LeadCreatedSubscriber[];
  waitUntil: (promise: Promise<unknown>) => void;
}): LeadCreatedPublisher => {
  const { environment, subscribers, waitUntil } = options;
  return {
    publishLeadCreated(event) {
      try {
        waitUntil(runLeadCreatedSubscribers(environment, subscribers, event));
      } catch (error) {
        logNotificationEventOutcome({
          errorClass: errorClass(error),
          eventKind: LEAD_CREATED_EVENT,
          leadId: event.leadId,
          outcome: 'scheduling_failed',
        });
      }
    },
  };
};

/**
 * Recording publisher for tests and non-Worker callers. It keeps the promises
 * observable so a test can await the exact subscriber work the production
 * `waitUntil` would own.
 */
export type RecordingLeadCreatedPublisher = LeadCreatedPublisher & {
  events: LeadCreatedEvent[];
  flush: () => Promise<void>;
  pending: Array<Promise<void>>;
};

export const createRecordingLeadCreatedPublisher = (
  environment: Env,
  subscribers: readonly LeadCreatedSubscriber[] = [],
): RecordingLeadCreatedPublisher => {
  const events: LeadCreatedEvent[] = [];
  const pending: Array<Promise<void>> = [];
  return {
    events,
    flush: async () => {
      await Promise.allSettled(pending);
    },
    pending,
    publishLeadCreated: (event) => {
      events.push(event);
      pending.push(runLeadCreatedSubscribers(environment, subscribers, event));
    },
  };
};
