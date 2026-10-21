/**
 * Request-scoped and composition services used by the Effect HTTP handlers.
 *
 * The API definitions stay free of server implementation, while these
 * services let handlers yield their dependencies instead of closing over
 * mutable composition state.
 */

import { requestWaitUntil } from './execution-context';
import { type StaffContext } from './guards';
import { type Env } from '@/db/env';
import {
  createLeadCreatedPublisher,
  type LeadCreatedPublisher,
  type LeadCreatedSubscriber,
  type NotificationRuntime,
  type NotificationServices,
} from '@/notifications/events';
import { requestTrace } from '@/telemetry/request';
import { type TraceContext } from '@/telemetry/trace-context';
import { Context, Effect } from 'effect';

export type NotificationDispatcherShape = {
  readonly runtime: NotificationRuntime;
  readonly subscribers: readonly LeadCreatedSubscriber[];
};

export type StaffWithSession = StaffContext & {
  adminSession: NonNullable<StaffContext['adminSession']>;
};

export type StaffWithUser = StaffContext & {
  adminUserId: string;
};

export class ApiEnvironment extends Context.Service<ApiEnvironment, Env>()(
  'leadscroll/api/ApiEnvironment',
) {}

export class CurrentStaff extends Context.Service<CurrentStaff, StaffContext>()(
  'leadscroll/api/CurrentStaff',
) {}

export class CurrentStaffSession extends Context.Service<
  CurrentStaffSession,
  StaffWithSession
>()('leadscroll/api/CurrentStaffSession') {}

export class CurrentStaffUser extends Context.Service<
  CurrentStaffUser,
  StaffWithUser
>()('leadscroll/api/CurrentStaffUser') {}

export class NotificationDispatcher extends Context.Service<
  NotificationDispatcher,
  NotificationDispatcherShape
>()('leadscroll/api/NotificationDispatcher') {}

/**
 * Runs an application command with the notification composition's services
 * (Deployment, InstallationConfigStore, CredentialCipher, provider resolver).
 * The ManagedRuntime remains the integration boundary for background email
 * work and configuration services.
 */
export const withNotificationServices = <A, E, R extends NotificationServices>(
  dispatcher: NotificationDispatcherShape,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, NotificationServices>> =>
  Effect.gen(function* () {
    const context = yield* Effect.promise(() => dispatcher.runtime.context());
    return yield* effect.pipe(Effect.provideContext(context));
  });

export const publisherFor = (
  dispatcher: NotificationDispatcherShape,
  request: Request,
  trace: null | TraceContext = requestTrace(request),
): LeadCreatedPublisher =>
  createLeadCreatedPublisher({
    runtime: dispatcher.runtime,
    subscribers: dispatcher.subscribers,
    trace,
    waitUntil: (promise) => {
      const waitUntil = requestWaitUntil(request);
      if (waitUntil === null) {
        throw new Error(
          'No Worker execution context is registered for this request.',
        );
      }

      waitUntil(promise);
    },
  });
